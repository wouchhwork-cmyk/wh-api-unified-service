import { describe, expect, it } from 'vitest';
import {
  MetaRateLimitService,
  type MetaRateLimitOverview,
} from '@/modules/platform/meta-rate-limit.service';
import type {
  MetaApiUsageRepository,
  MetaUsageCurrentRow,
} from '@/database/repositories/meta-api-usage.repository';
import { MetaUsageMeter } from '@/shared/enums';

/**
 * What the platform console is shown.
 *
 * THE SHAPING IS WHERE THE LIES HAPPEN. The repository returns rows that are
 * simply true; this service decides which pool is "the app pool", what counts as
 * throttled, and which window a percentage belongs to — and every defect found
 * in this feature so far has been one of those three decisions, not the data.
 *
 * Driven directly with rows rather than through Postgres, because the rules
 * under test are pure and a database would only make it slower to see which one
 * fired.
 */
describe('the rate-limit console view', () => {
  const row = (over: Partial<MetaUsageCurrentRow> = {}): MetaUsageCurrentRow => ({
    scopeKey: 'IG:instagram',
    meter: MetaUsageMeter.BusinessUseCase,
    product: 'instagram',
    metaBusinessId: 'IG',
    enterpriseId: 1,
    enterpriseName: 'Acme',
    enterpriseRefId: 'acme-ref',
    channelId: 5,
    channelName: 'The Shop',
    channelPlatform: 'instagram',
    platformChannelId: 'IG',
    callPct: 10,
    cpuPct: 1,
    timePct: 1,
    regainMinutes: null,
    lastSeenAt: new Date(),
    latestThrottledCalls: 0,
    hourCalls: 3,
    hourThrottledCalls: 0,
    hourFailedCalls: 0,
    dayCalls: 40,
    dayThrottledCalls: 0,
    dayFailedCalls: 0,
    ...over,
  });

  const overviewOf = async (rows: MetaUsageCurrentRow[]): Promise<MetaRateLimitOverview> => {
    const repository = { current: async () => rows } as unknown as MetaApiUsageRepository;
    return new MetaRateLimitService(repository).overview();
  };

  describe('which row is the app pool', () => {
    it('is the app METER, and a headerless row never displaces it', async () => {
      /*
       * THE REGRESSION THIS FILE EXISTS FOR. A call that came back with no
       * usage header used to share the app meter. The grouping keys the app
       * gauge off the meter, so that row WAS the app pool as far as the console
       * was concerned — and carrying no percentage it sorted last, so it
       * overwrote the genuine reading every time.
       *
       * Moving it to its own scope key fixed nothing on its own. The meter had
       * to move with it.
       */
      const view = await overviewOf([
        row({ scopeKey: 'app', meter: MetaUsageMeter.App, callPct: 60, product: null,
              metaBusinessId: null, enterpriseId: null, enterpriseName: null,
              enterpriseRefId: null, channelId: null }),
        row({ scopeKey: 'unknown', meter: MetaUsageMeter.Unknown, callPct: null,
              product: null, metaBusinessId: null, enterpriseId: null,
              enterpriseName: null, enterpriseRefId: null, channelId: null }),
      ]);

      expect(view.app?.usedPercent).toBe(60);
      expect(view.app?.scopeKey).toBe('app');
    });

    it('still shows the headerless calls, rather than hiding them', async () => {
      // They are calls we really made. They just belong to no pool.
      const view = await overviewOf([
        row({ scopeKey: 'unknown', meter: MetaUsageMeter.Unknown, callPct: null,
              product: null, metaBusinessId: null, enterpriseId: null,
              enterpriseName: null, enterpriseRefId: null, channelId: null }),
      ]);

      expect(view.app).toBeNull();
      expect(view.unattributed.map((pool) => pool.scopeKey)).toEqual(['unknown']);
    });
  });

  describe('when a pool counts as throttled', () => {
    it('is throttled while it is STILL being refused', async () => {
      const view = await overviewOf([row({ latestThrottledCalls: 2, dayThrottledCalls: 2 })]);

      expect(view.enterprises[0]?.pools[0]?.status).toBe('throttled');
    });

    it('is NOT throttled because of a refusal earlier in the day', async () => {
      /*
       * One 80004 at breakfast used to pin a pool red — and the enterprise
       * heading, and the banner — until breakfast the next day, long after Meta
       * had gone back to reporting 3%. The signal wanted is "something is STILL
       * hammering a pool that has already said no".
       */
      const view = await overviewOf([
        row({ latestThrottledCalls: 0, dayThrottledCalls: 9, callPct: 3 }),
      ]);

      const pool = view.enterprises[0]?.pools[0];
      expect(pool?.status).toBe('ok');
      // Still reported, because the volume is worth seeing.
      expect(pool?.throttledCallsInWindow).toBe(9);
      expect(view.attention).toEqual([]);
    });

    it('is throttled while Meta is still quoting a wait', async () => {
      const view = await overviewOf([row({ latestThrottledCalls: 0, regainMinutes: 12 })]);

      expect(view.enterprises[0]?.pools[0]?.status).toBe('throttled');
    });
  });

  describe('which window a pool is measured over', () => {
    it('gives an unrecognised product the BUSINESS window, not the app one', async () => {
      /*
       * Every business-use-case pool Meta meters runs over 24 hours, and Meta
       * adds `type` values. Falling back to 60 minutes labelled a day's
       * percentage as an hour's and read the hour's call count beside it —
       * understating the pool by up to twenty-four times.
       */
      const view = await overviewOf([row({ product: 'something_meta_added' })]);

      const pool = view.enterprises[0]?.pools[0];
      expect(pool?.windowMinutes).toBe(24 * 60);
      expect(pool?.callsInWindow).toBe(40);
    });

    it('keeps the app pool on its hourly window', async () => {
      const view = await overviewOf([
        row({ scopeKey: 'app', meter: MetaUsageMeter.App, product: null,
              metaBusinessId: null, enterpriseId: null, enterpriseName: null,
              enterpriseRefId: null, channelId: null }),
      ]);

      expect(view.app?.windowMinutes).toBe(60);
      expect(view.app?.callsInWindow).toBe(3);
    });
  });

  describe('the headline percentage', () => {
    it('is the WORST of the three, not the call count', async () => {
      // Calls, CPU time and total time are metered separately and any one of
      // them reaching 100 throttles the pool.
      const view = await overviewOf([row({ callPct: 10, cpuPct: 91, timePct: 4 })]);

      expect(view.enterprises[0]?.pools[0]?.usedPercent).toBe(91);
      expect(view.enterprises[0]?.pools[0]?.status).toBe('warning');
    });

    it('is unknown, not zero, when Meta said nothing', async () => {
      const view = await overviewOf([row({ callPct: null, cpuPct: null, timePct: null })]);

      const pool = view.enterprises[0]?.pools[0];
      expect(pool?.usedPercent).toBeNull();
      expect(pool?.remainingPercent).toBeNull();
      expect(pool?.status).toBe('unknown');
    });
  });
});
