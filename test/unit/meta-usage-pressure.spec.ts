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

  it('claims nothing while a pool is close to its limit', async () => {
    const usage = collector();
    usage.observe({
      readings: [reading({ callPct: META_USAGE_SOFT_LIMIT_PCT + 5 })],
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
      readings: [reading({ callPct: META_USAGE_SOFT_LIMIT_PCT - 5 })],
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
