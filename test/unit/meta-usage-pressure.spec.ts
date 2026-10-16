import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PinoLogger } from 'nestjs-pino';
import type { AppConfigService } from '@/config';
import type { ChannelRepository } from '@/database/repositories/channel.repository';
import type { MessageRepository } from '@/database/repositories/message.repository';
import type { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import type { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';
import type { ProviderApiUsageRepository } from '@/database/repositories/provider-api-usage.repository';
import type { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import { MetaUsageCollector } from '@/modules/connections/graph/meta-usage.collector';
import { OutboundRelayWorker } from '@/workers/outbound-relay.worker';
import type { TransactionManager } from '@/database/transaction/transaction.manager';
import type { TokenCipherService } from '@/shared/crypto';
import { MetaUsageMeter } from '@/shared/enums';
import { META_USAGE_PRESSURE_WINDOW_MS, META_USAGE_SOFT_LIMIT_PCT } from '@/shared/constants';
import { MetaUsageMeter as Meter } from '@/shared/enums';

/**
 * Slowing down BEFORE Meta refuses us.
 *
 * Every Graph response carries the share of the budget already spent, and
 * nothing read it on the way past — so the first sign of trouble was a `(#4)`,
 * by which point a business's sending had already stopped. Meta is explicit
 * that calling while throttled EXTENDS the block, so the calls made after the
 * first refusal cost more than the ones that caused it.
 *
 * The assertions that matter most are the FAIL-OPEN ones. A brake that engages
 * when it should not is an inbox that silently stops sending, which is worse
 * than the problem it was built to avoid.
 */

const silentLogger = () =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as PinoLogger;

const collector = (): MetaUsageCollector =>
  new MetaUsageCollector(
    { record: vi.fn(), resolveOwners: vi.fn().mockResolvedValue([]) } as unknown as ProviderApiUsageRepository,
    silentLogger(),
  );

const reading = (overrides: Record<string, unknown> = {}) => ({
  meter: MetaUsageMeter.BusinessUseCase,
  providerScopeId: 'scope-1',
  product: 'instagram',
  callPct: 10,
  cpuPct: 10,
  timePct: 10,
  regainMinutes: null,
  ...overrides,
});

describe('MetaUsageCollector.pressure', () => {
  it('reports nothing when it has seen nothing', () => {
    // FAIL OPEN. A fresh process must not look like an exhausted budget.
    expect(collector().pressure()).toBe(0);
  });

  it('reports the worst of the three meters', () => {
    // Any one of them being full refuses the call, so the worst is the truth.
    const usage = collector();
    usage.observe({ readings: [reading({ callPct: 12, cpuPct: 91, timePct: 40 })], throttled: false, failed: false });

    expect(usage.pressure()).toBe(91);
  });

  it('reports the worst pool, not the last one seen', () => {
    const usage = collector();
    usage.observe({ readings: [reading({ providerScopeId: 'a', callPct: 95 })], throttled: false, failed: false });
    usage.observe({ readings: [reading({ providerScopeId: 'b', callPct: 5 })], throttled: false, failed: false });

    expect(usage.pressure()).toBe(95);
  });

  it('forgets a reading once it is stale', () => {
    /*
     * Meta's percentages are of a rolling hourly budget, so an old figure would
     * brake a system that has long since recovered.
     */
    const usage = collector();
    usage.observe({ readings: [reading({ callPct: 99 })], throttled: false, failed: false });

    const later = Date.now() + META_USAGE_PRESSURE_WINDOW_MS + 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect(usage.pressure()).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('survives a response Meta sent no headers on', () => {
    const usage = collector();
    usage.observe({ readings: [], throttled: false, failed: true });

    expect(usage.pressure()).toBe(0);
  });
});

describe('MetaUsageCollector, per pool', () => {
  /*
   * The P1 remainder. `pressure()` collapsed every pool into one number, so a
   * single busy tenant braked the shared queue for everybody — their allowance
   * is spent, the queue is not theirs.
   */
  it('reports one account’s own pools, not everybody’s', () => {
    const usage = collector();
    usage.observe({
      readings: [reading({ providerScopeId: 'loud', callPct: 95 })],
      throttled: false,
      failed: false,
    });
    usage.observe({
      readings: [reading({ providerScopeId: 'quiet', callPct: 3, cpuPct: 1, timePct: 2 })],
      throttled: false,
      failed: false,
    });

    expect(usage.pressureFor('loud')).toBe(95);
    expect(usage.pressureFor('quiet')).toBe(3);
    // An account we have never called for is not under pressure.
    expect(usage.pressureFor('unknown')).toBe(0);
    expect(usage.pressureFor(null)).toBe(0);
  });

  /*
   * The APP pool is the one that means stop: it is shared by every tenant, so
   * spending it refuses the next call from anybody (todo E17).
   */
  it('separates the shared app pool from one business’s', () => {
    const usage = collector();
    usage.observe({
      readings: [reading({ providerScopeId: 'loud', callPct: 99 })],
      throttled: false,
      failed: false,
    });

    // A business at 99% must NOT read as the app pool being spent, or one
    // tenant stops the whole deployment again by another route.
    expect(usage.appPressure()).toBe(0);

    usage.observe({
      readings: [reading({ meter: Meter.App, providerScopeId: null, callPct: 88 })],
      throttled: false,
      failed: false,
    });
    expect(usage.appPressure()).toBe(88);
  });
});

describe('MetaUsageCollector attribution', () => {
  /*
   * E16. The same Page is legitimately connected by an agency and by the brand
   * it manages, so resolving its id returns a row each. Collapsing them into a
   * map kept whichever came last and reported that business as the owner of
   * usage both of them caused — on a console somebody reads during an incident
   * to decide who to call. A wrong name is worse than no name.
   */
  it('leaves a pool shared by two businesses unattributed', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const usage = new MetaUsageCollector(
      {
        record,
        resolveOwners: vi.fn().mockResolvedValue([
          { platformChannelId: 'SHARED', channelId: 1, enterpriseId: 10 },
          { platformChannelId: 'SHARED', channelId: 2, enterpriseId: 20 },
        ]),
      } as unknown as ProviderApiUsageRepository,
      silentLogger(),
    );

    usage.observe({
      readings: [reading({ providerScopeId: 'SHARED' })],
      throttled: false,
      failed: false,
    });
    await usage.flush();

    const written = record.mock.calls[0]?.[0] as { enterpriseId: number | null }[];
    expect(written[0]?.enterpriseId).toBeNull();
  });

  it('still attributes a pool only one business holds', async () => {
    // The control: unattributing everything would be no better than guessing.
    const record = vi.fn().mockResolvedValue(undefined);
    const usage = new MetaUsageCollector(
      {
        record,
        resolveOwners: vi
          .fn()
          .mockResolvedValue([{ platformChannelId: 'MINE', channelId: 1, enterpriseId: 10 }]),
      } as unknown as ProviderApiUsageRepository,
      silentLogger(),
    );

    usage.observe({
      readings: [reading({ providerScopeId: 'MINE' })],
      throttled: false,
      failed: false,
    });
    await usage.flush();

    const written = record.mock.calls[0]?.[0] as { enterpriseId: number | null }[];
    expect(written[0]?.enterpriseId).toBe(10);
  });
});

describe('OutboundRelayWorker under pressure', () => {
  let outbound: { claimDueBatch: ReturnType<typeof vi.fn> };
  let logger: PinoLogger;

  const buildWorker = (usage?: MetaUsageCollector): OutboundRelayWorker =>
    new OutboundRelayWorker(
      outbound as unknown as OutboundEventRepository,
      {} as ChannelRepository,
      {} as ProviderConnectionRepository,
      {} as MessageRepository,
      {} as GraphApiClient,
      {} as TokenCipherService,
      {} as TransactionManager,
      { worker: { batchSize: 20, leaseSeconds: 30 } } as unknown as AppConfigService,
      logger,
      usage,
    );

  /** pollOnce is protected; the poller calls it and so does this. */
  const poll = (worker: OutboundRelayWorker): Promise<number> =>
    (worker as unknown as { pollOnce(): Promise<number> }).pollOnce();

  beforeEach(() => {
    outbound = { claimDueBatch: vi.fn().mockResolvedValue([]) };
    logger = silentLogger();
  });

  it('claims nothing while the SHARED app pool is close to its limit', async () => {
    const usage = collector();
    usage.observe({
      readings: [
        reading({
          meter: Meter.App,
          providerScopeId: null,
          callPct: META_USAGE_SOFT_LIMIT_PCT + 5,
        }),
      ],
      throttled: false,
      failed: false,
    });

    await poll(buildWorker(usage));

    /*
     * Nothing is CLAIMED, rather than claimed and slept on: the rows stay
     * unleased, so a pool that recovers is used again on the next poll and
     * another relay is free to take the work.
     */
    expect(outbound.claimDueBatch).not.toHaveBeenCalled();
  });

  it('sends normally below the limit', async () => {
    const usage = collector();
    usage.observe({
      readings: [
        reading({
          meter: Meter.App,
          providerScopeId: null,
          callPct: META_USAGE_SOFT_LIMIT_PCT - 5,
        }),
      ],
      throttled: false,
      failed: false,
    });

    await poll(buildWorker(usage));

    expect(outbound.claimDueBatch).toHaveBeenCalledTimes(1);
  });

  /*
   * THE WHOLE POINT OF THE NARROWING. One business spending its own allowance
   * must not stop the queue, because the queue carries everybody's replies.
   */
  it('keeps claiming while only ONE business is near its limit', async () => {
    const usage = collector();
    usage.observe({
      readings: [reading({ providerScopeId: 'loud', callPct: 99 })],
      throttled: false,
      failed: false,
    });

    await poll(buildWorker(usage));

    expect(outbound.claimDueBatch).toHaveBeenCalledTimes(1);
  });

  it('sends when there is no collector at all', async () => {
    // FAIL OPEN, again: the API process wires no collector into this worker,
    // and a missing observer must never read as an exhausted budget.
    await poll(buildWorker(undefined));

    expect(outbound.claimDueBatch).toHaveBeenCalledTimes(1);
  });
});
