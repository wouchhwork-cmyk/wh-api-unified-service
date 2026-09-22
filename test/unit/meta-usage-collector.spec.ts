import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MetaApiUsageRepository,
  MetaScopeOwner,
  MetaUsageBucket,
} from '@/database/repositories/meta-api-usage.repository';
import { MetaUsageCollector } from '@/modules/connections/graph/meta-usage.collector';
import type { MetaUsageReading } from '@/modules/connections/graph/graph-usage.parser';
import { MetaUsageMeter } from '@/shared/enums';

/**
 * Accumulating rate-limit readings without getting in the way.
 *
 * The collector sits on the path of every Graph call, so the properties under
 * test are as much about what it must NOT do as what it does: no I/O while
 * recording, no throwing, no unbounded growth, and no inventing a reading Meta
 * never sent.
 *
 * The arithmetic is the other half. Counts and percentages are folded by
 * DIFFERENT rules — one sums, the other takes the highest — and getting that
 * backwards produces a dashboard that is confidently wrong rather than broken,
 * which is the failure nobody notices.
 */
describe('MetaUsageCollector', () => {
  let written: MetaUsageBucket[];
  let owners: MetaScopeOwner[];
  let resolveCalls: number;
  let collector: MetaUsageCollector;

  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };

  const repository = {
    record: async (buckets: readonly MetaUsageBucket[]): Promise<number> => {
      written.push(...buckets);
      return buckets.length;
    },
    resolveOwners: async (ids: readonly string[]): Promise<MetaScopeOwner[]> => {
      resolveCalls += 1;
      return owners.filter((owner) => ids.includes(owner.platformChannelId));
    },
  } as unknown as MetaApiUsageRepository;

  const reading = (over: Partial<MetaUsageReading> = {}): MetaUsageReading => ({
    meter: MetaUsageMeter.BusinessUseCase,
    product: 'instagram',
    metaBusinessId: 'IG_ACCOUNT',
    callPct: 10,
    cpuPct: 1,
    timePct: 1,
    regainMinutes: null,
    ...over,
  });

  const ok = (readings: MetaUsageReading[]): void =>
    collector.observe({ readings, throttled: false, failed: false });

  beforeEach(() => {
    written = [];
    resolveCalls = 0;
    owners = [{ platformChannelId: 'IG_ACCOUNT', channelId: 7, enterpriseId: 3 }];
    vi.clearAllMocks();
    collector = new MetaUsageCollector(repository, logger as never);
  });

  const only = (scopeKey: string): MetaUsageBucket => {
    const found = written.find((bucket) => bucket.scopeKey === scopeKey);
    if (!found) throw new Error(`no bucket for ${scopeKey}; got ${written.map((b) => b.scopeKey).join(', ')}`);
    return found;
  };

  describe('folding a minute together', () => {
    it('writes one row for many calls to the same pool', async () => {
      // The entire reason it buffers: a backfill making hundreds of calls a
      // minute must cost one UPSERT, not hundreds.
      for (let index = 0; index < 50; index += 1) ok([reading()]);
      await collector.flush();

      expect(written).toHaveLength(1);
      expect(only('IG_ACCOUNT:instagram').calls).toBe(50);
    });

    it('SUMS our counts and takes the HIGHEST of Meta percentages', async () => {
      /*
       * The two rules that must not be swapped. Three calls are three calls —
       * they add. Three readings of 10, 40 and 20 percent are three
       * observations of ONE global position, so the pool reached 40%, not 70%.
       */
      ok([reading({ callPct: 10 })]);
      ok([reading({ callPct: 40 })]);
      ok([reading({ callPct: 20 })]);
      await collector.flush();

      const bucket = only('IG_ACCOUNT:instagram');
      expect(bucket.calls).toBe(3);
      expect(bucket.callPct).toBe(40);
    });

    it('does not let a later silent response erase a percentage', async () => {
      /*
       * Meta omits the header on some responses. Folding that in as zero — or
       * as "most recent wins" — would blank a reading of 80% the instant a
       * quiet call followed it, which is exactly when the number matters.
       */
      ok([reading({ callPct: 80 })]);
      ok([reading({ callPct: null })]);
      await collector.flush();

      expect(only('IG_ACCOUNT:instagram').callPct).toBe(80);
    });

    it('keeps a pool per product for the same asset', async () => {
      // A Page node read and its conversations edge draw on separate pools.
      ok([reading({ metaBusinessId: 'PAGE', product: 'pages', callPct: 5 })]);
      ok([reading({ metaBusinessId: 'PAGE', product: 'messenger', callPct: 60 })]);
      await collector.flush();

      expect(only('PAGE:pages').callPct).toBe(5);
      expect(only('PAGE:messenger').callPct).toBe(60);
    });

    it('counts a call against every pool the response named', async () => {
      // One Instagram read reports under the business AND the account; both
      // pools genuinely were drawn on.
      ok([
        reading({ metaBusinessId: 'BUSINESS' }),
        reading({ metaBusinessId: 'IG_ACCOUNT' }),
      ]);
      await collector.flush();

      expect(written).toHaveLength(2);
      expect(only('BUSINESS:instagram').calls).toBe(1);
      expect(only('IG_ACCOUNT:instagram').calls).toBe(1);
    });
  });

  describe('counting what went wrong', () => {
    it('records a throttled call against the pool that refused it', async () => {
      collector.observe({ readings: [reading()], throttled: true, failed: true });
      await collector.flush();

      const bucket = only('IG_ACCOUNT:instagram');
      expect(bucket.throttledCalls).toBe(1);
      expect(bucket.failedCalls).toBe(1);
      expect(bucket.calls).toBe(1);
    });

    it('still counts a call that never came back, WITHOUT claiming the app pool', async () => {
      /*
       * A timeout has no headers at all, but the call was made. Dropping it
       * would make the monitor under-report exactly when Meta is struggling —
       * the one moment it is being read.
       *
       * It used to be counted against the APP pool, and that was wrong in the
       * way that matters most. The two meters are mutually exclusive: a
       * Page-token inbox call never touches the app allowance. So a single
       * timed-out inbox call wrote an `app` row with a NULL percentage, and
       * because the console reads the LATEST row per pool that blanked the app
       * gauge to "unknown" — dropping a pool sitting at 95% off the
       * needs-attention banner for a reason that had nothing to do with it.
       */
      collector.observe({ readings: [], throttled: false, failed: true });
      await collector.flush();

      expect(only('unknown').calls).toBe(1);
      expect(only('unknown').failedCalls).toBe(1);
      expect(only('unknown').callPct).toBeNull();
      expect(written.map((bucket) => bucket.scopeKey)).not.toContain('app');
      /*
       * THE METER, not just the scope key. Moving the key without moving the
       * meter changed nothing: the console groups the app gauge BY METER, so
       * the headerless row was still the app pool as far as it was concerned —
       * and carrying no percentage it sorted last, so it won every time.
       */
      expect(only('unknown').meter).toBe(MetaUsageMeter.Unknown);
    });

    it('leaves a real app reading alone when a headerless call happens beside it', async () => {
      // The failure above, from the console's point of view: the app gauge must
      // still read 60% after an unrelated inbox call times out.
      collector.observe({
        readings: [reading({ meter: MetaUsageMeter.App, metaBusinessId: null, product: null, callPct: 60 })],
        throttled: false,
        failed: false,
      });
      collector.observe({ readings: [], throttled: false, failed: true });
      await collector.flush();

      expect(only('app').callPct).toBe(60);
      expect(only('unknown').callPct).toBeNull();
    });
  });

  describe('attributing a pool to a business', () => {
    it('resolves a channel from the id Meta named', async () => {
      ok([reading({ metaBusinessId: 'IG_ACCOUNT' })]);
      await collector.flush();

      expect(only('IG_ACCOUNT:instagram')).toMatchObject({ channelId: 7, enterpriseId: 3 });
    });

    it('infers the owner of a business pool from the account beside it', async () => {
      /*
       * The reason the dashboard has no permanent blind spot. `BUSINESS` is a
       * Meta Business id and will never match a channel of ours, but it arrives
       * on the same response as an account that does — so the pool belongs to
       * that account's business. The channel stays null, correctly: this is a
       * business-level pool, not an asset.
       */
      ok([reading({ metaBusinessId: 'BUSINESS' }), reading({ metaBusinessId: 'IG_ACCOUNT' })]);
      await collector.flush();

      expect(only('BUSINESS:instagram')).toMatchObject({ enterpriseId: 3, channelId: null });
    });

    it('refuses to guess when two businesses share the pool', async () => {
      /*
       * A Meta Business owning assets connected by two of our tenants is
       * genuinely shared quota. Attributing it to either would put one
       * business's spending on another's row, so it stays unattributed and the
       * console shows it under its Meta id — which is the truth.
       */
      owners = [
        { platformChannelId: 'IG_A', channelId: 1, enterpriseId: 3 },
        { platformChannelId: 'IG_B', channelId: 2, enterpriseId: 4 },
      ];
      ok([
        reading({ metaBusinessId: 'BUSINESS' }),
        reading({ metaBusinessId: 'IG_A' }),
        reading({ metaBusinessId: 'IG_B' }),
      ]);
      await collector.flush();

      expect(only('BUSINESS:instagram').enterpriseId).toBeNull();
    });

    it('leaves an id it cannot place unattributed rather than dropping it', async () => {
      owners = [];
      ok([reading({ metaBusinessId: 'STRANGER' })]);
      await collector.flush();

      const bucket = only('STRANGER:instagram');
      expect(bucket.enterpriseId).toBeNull();
      expect(bucket.metaBusinessId).toBe('STRANGER');
      expect(bucket.calls).toBe(1);
    });

    it('caches the lookup instead of asking on every flush', async () => {
      // Otherwise the monitor costs a query every fifteen seconds forever, for
      // an answer that changes only when somebody connects an account.
      ok([reading()]);
      await collector.flush();
      ok([reading()]);
      await collector.flush();

      expect(resolveCalls).toBe(1);
    });

    it('remembers that an id is NOT ours, so it stops asking', async () => {
      owners = [];
      ok([reading({ metaBusinessId: 'STRANGER' })]);
      await collector.flush();
      ok([reading({ metaBusinessId: 'STRANGER' })]);
      await collector.flush();

      expect(resolveCalls).toBe(1);
    });
  });

  describe('never getting in the way', () => {
    it('does not throw when the database refuses the write', async () => {
      const broken = {
        record: async () => {
          throw new Error('database is down');
        },
        resolveOwners: async () => [],
      } as unknown as MetaApiUsageRepository;
      const fragile = new MetaUsageCollector(broken, logger as never);

      fragile.observe({ readings: [reading()], throttled: false, failed: false });

      await expect(fragile.flush()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });

    it('drops a failed flush rather than retrying it', async () => {
      /*
       * Deliberate. Retrying monitoring data would grow the buffer during
       * exactly the incident that broke the database, turning an observer into
       * a second outage. The next flush reports the current position anyway,
       * which is the number anybody is actually looking at.
       */
      let attempts = 0;
      const flaky = {
        record: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('transient');
          return 0;
        },
        resolveOwners: async () => [],
      } as unknown as MetaApiUsageRepository;
      const collectorUnderTest = new MetaUsageCollector(flaky, logger as never);

      collectorUnderTest.observe({ readings: [reading()], throttled: false, failed: false });
      await collectorUnderTest.flush();
      await collectorUnderTest.flush();

      expect(attempts).toBe(1);
    });

    it('writes nothing when nothing happened', async () => {
      await collector.flush();

      expect(written).toEqual([]);
      expect(resolveCalls).toBe(0);
    });

    it('clears the buffer so a second flush does not double-count', async () => {
      ok([reading()]);
      await collector.flush();
      await collector.flush();

      expect(written).toHaveLength(1);
      expect(written[0]?.calls).toBe(1);
    });
  });

  describe('bucketing', () => {
    it('stamps the start of the minute, not the moment of the call', async () => {
      // The bucket start IS the conflict target, so it has to be identical for
      // every call in the minute or the UPSERT folds nothing together.
      ok([reading()]);
      await collector.flush();

      const start = only('IG_ACCOUNT:instagram').bucketStart;
      expect(start.getSeconds()).toBe(0);
      expect(start.getMilliseconds()).toBe(0);
    });

    it('records when the pool was last heard from', async () => {
      const before = Date.now();
      ok([reading()]);
      await collector.flush();

      const bucket = only('IG_ACCOUNT:instagram');
      expect(bucket.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(bucket.lastSeenAt.getTime()).toBeGreaterThanOrEqual(bucket.bucketStart.getTime());
    });
  });
});
