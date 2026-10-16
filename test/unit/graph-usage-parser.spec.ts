import { describe, expect, it } from 'vitest';
import {
  longestRegainMinutes,
  parseUsageReadings,
} from '@/modules/connections/graph/graph-usage.parser';
import { MetaUsageMeter } from '@/shared/enums';

/**
 * Reading Meta's rate-limit headers.
 *
 * EVERY FIXTURE HERE IS REAL. These are the exact header values returned by the
 * live Graph API on 21 Sep 2026, captured with a read-only probe against our own
 * app (`v25.0`, app `1174274799094721`, Page `651551841371924`, Instagram
 * `17841472020051826`). Inventing them would have hidden the two findings that
 * shaped the whole feature: that Instagram reports under TWO ids, and that the
 * same Page token reports a different pool depending on the edge.
 */
describe('Meta usage headers', () => {
  /** An ordinary 200 from an app-token call. */
  const APP = '{"call_count":12,"total_cputime":0,"total_time":0}';

  /** GET /{page-id} — a Page node read. */
  const PAGES =
    '{"651551841371924":[{"type":"pages","call_count":0,"total_cputime":0,' +
    '"total_time":0,"estimated_time_to_regain_access":0}]}';

  /** GET /{page-id}/conversations — the SAME token, a different pool. */
  const MESSENGER =
    '{"651551841371924":[{"type":"messenger","call_count":1,"total_cputime":1,' +
    '"total_time":1,"estimated_time_to_regain_access":0}]}';

  /** GET /{ig-id} — one read, reported under the business AND the account. */
  const INSTAGRAM =
    '{"645699291956344":[{"type":"instagram","call_count":1,"total_cputime":1,' +
    '"total_time":1,"estimated_time_to_regain_access":0}],' +
    '"17841472020051826":[{"type":"instagram","call_count":1,"total_cputime":1,' +
    '"total_time":1,"estimated_time_to_regain_access":0}]}';

  describe('the app meter', () => {
    it('reads the three percentages', () => {
      const [reading] = parseUsageReadings({ 'x-app-usage': APP });

      expect(reading).toMatchObject({
        meter: MetaUsageMeter.App,
        callPct: 12,
        cpuPct: 0,
        timePct: 0,
        product: null,
        providerScopeId: null,
      });
    });

    it('carries no regain estimate, because Meta does not send one', () => {
      /*
       * THE GAP WORTH KNOWING ABOUT. `X-App-Usage` has three fields and none of
       * them is `estimated_time_to_regain_access` — that field exists only on
       * the business header. So when the app pool throttles, Meta tells us
       * nothing about how long to wait and the caller must fall back to its own
       * park window. Asserted so that a future "simplification" that treats the
       * two headers as one shape fails here rather than in production.
       */
      const [reading] = parseUsageReadings({ 'x-app-usage': APP });

      expect(reading?.regainMinutes).toBeNull();
      expect(longestRegainMinutes({ 'x-app-usage': APP })).toBeNull();
    });
  });

  describe('the business meter', () => {
    it('reads a pool and keeps the id Meta keyed it under', () => {
      const [reading] = parseUsageReadings({ 'x-business-use-case-usage': MESSENGER });

      expect(reading).toMatchObject({
        meter: MetaUsageMeter.BusinessUseCase,
        product: 'messenger',
        providerScopeId: '651551841371924',
        callPct: 1,
      });
    });

    it('separates the pools of one asset', () => {
      /*
       * The finding that made per-channel reporting insufficient on its own. The
       * SAME Page id and the SAME token: a node read meters against `pages`, its
       * conversations edge against `messenger`. Reporting usage per channel
       * without the product would average two independent pools into one
       * meaningless number.
       */
      const pages = parseUsageReadings({ 'x-business-use-case-usage': PAGES });
      const messenger = parseUsageReadings({ 'x-business-use-case-usage': MESSENGER });

      expect(pages[0]?.providerScopeId).toBe(messenger[0]?.providerScopeId);
      expect(pages[0]?.product).toBe('pages');
      expect(messenger[0]?.product).toBe('messenger');
    });

    it('returns one reading per id when Instagram reports under two', () => {
      /*
       * One Graph call, two entries: the owning Meta Business and the Instagram
       * account itself. Only the second is one of our channels, which is why
       * attribution has to cope with an id that matches nothing — and why the
       * collector infers the business-level pool's owner from the account
       * beside it.
       */
      const readings = parseUsageReadings({ 'x-business-use-case-usage': INSTAGRAM });

      expect(readings).toHaveLength(2);
      expect(readings.map((reading) => reading.providerScopeId).sort()).toEqual([
        '17841472020051826',
        '645699291956344',
      ]);
      expect(readings.every((reading) => reading.product === 'instagram')).toBe(true);
    });

    it('tolerates a bare object where Meta documents an array', () => {
      // Costs one branch; the shape is Meta's to change and has before.
      const readings = parseUsageReadings({
        'x-business-use-case-usage': '{"1":{"type":"pages","call_count":4}}',
      });

      expect(readings).toHaveLength(1);
      expect(readings[0]?.callPct).toBe(4);
    });
  });

  describe('absence is not zero', () => {
    it('returns nothing at all when Meta sent no header', () => {
      /*
       * A DOCUMENTED CASE, not a defect: Meta says the header appears on
       * endpoints receiving enough requests. The distinction matters because a
       * reading of 0% and no reading at all lead to opposite decisions — one
       * says there is room, the other says we cannot see.
       */
      expect(parseUsageReadings({})).toEqual([]);
    });

    it('keeps a missing figure null rather than defaulting it', () => {
      const [reading] = parseUsageReadings({ 'x-app-usage': '{"call_count":7}' });

      expect(reading?.callPct).toBe(7);
      expect(reading?.cpuPct).toBeNull();
      expect(reading?.timePct).toBeNull();
    });

    it('keeps a real zero as zero', () => {
      // 0% used is a genuine reading and must not be confused with absence.
      const [reading] = parseUsageReadings({ 'x-business-use-case-usage': PAGES });

      expect(reading?.callPct).toBe(0);
    });
  });

  describe('a malformed header must not break the response', () => {
    /*
     * This runs on EVERY Graph response, including successful ones. A throw
     * here would turn a perfectly good answer into a failure — the headers are
     * commentary, the body is the answer.
     */
    it('survives invalid JSON', () => {
      expect(parseUsageReadings({ 'x-app-usage': 'not json' })).toEqual([]);
      expect(longestRegainMinutes({ 'x-app-usage': 'not json' })).toBeNull();
    });

    it('survives an array where an object belongs', () => {
      expect(parseUsageReadings({ 'x-business-use-case-usage': '[1,2,3]' })).toEqual([]);
    });

    it('survives nulls inside the array', () => {
      expect(parseUsageReadings({ 'x-business-use-case-usage': '{"1":[null]}' })).toEqual([]);
    });

    it('ignores a percentage that is not a number', () => {
      const [reading] = parseUsageReadings({ 'x-app-usage': '{"call_count":"lots"}' });

      expect(reading?.callPct).toBeNull();
    });
  });

  describe('how long to wait', () => {
    it('takes the LONGEST estimate across every pool named', () => {
      /*
       * Any shorter wait would still be throttled — and Meta states that
       * calling while throttled extends the block, so guessing low actively
       * makes the outage longer.
       */
      const header =
        '{"A":[{"type":"instagram","estimated_time_to_regain_access":19}],' +
        '"B":[{"type":"messenger","estimated_time_to_regain_access":42}]}';

      expect(longestRegainMinutes({ 'x-business-use-case-usage': header })).toBe(42);
    });

    it('treats zero as "not blocked", not as a wait of none', () => {
      /*
       * Meta reports 0 against pools sitting at 95% and 97%. Returning 0 here
       * would tell a caller it may retry immediately, which is the one thing it
       * must not do — null means "Meta did not say", and the caller falls back
       * to its own park window.
       */
      expect(longestRegainMinutes({ 'x-business-use-case-usage': PAGES })).toBeNull();
    });

    it('reads a Headers object as readily as a plain record', () => {
      // The plain form is what a fixture looks like; the Headers form is what a
      // real response gives. Both paths have to work or the tests prove nothing.
      const headers = new Headers({ 'x-business-use-case-usage': PAGES });

      expect(parseUsageReadings(headers)).toHaveLength(1);
    });
  });
});
