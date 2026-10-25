import { describe, expect, it } from 'vitest';
import { derivePeriodKey } from '@/modules/rewards/period-key.util';
import { RewardCapScope } from '@/shared/enums';

/**
 * The cap period an event falls into.
 *
 * Every case here is one where the obvious implementation is wrong: UTC instead
 * of the program's zone, the calendar year instead of the ISO week-year, a DST
 * boundary splitting or merging a day.
 */
describe('derivePeriodKey', () => {
  const KOLKATA = 'Asia/Kolkata';
  const NEW_YORK = 'America/New_York';

  it('has no key when there is no cap', () => {
    expect(derivePeriodKey(new Date(), KOLKATA, RewardCapScope.None)).toBeNull();
  });

  it('uses one key forever for a lifetime cap', () => {
    const a = derivePeriodKey(new Date('2026-01-01T00:00:00Z'), KOLKATA, RewardCapScope.Lifetime);
    const b = derivePeriodKey(new Date('2030-06-15T00:00:00Z'), KOLKATA, RewardCapScope.Lifetime);
    expect(a).toBe('LIFETIME');
    expect(b).toBe('LIFETIME');
  });

  /**
   * THE CASE THE WHOLE TIMEZONE ARGUMENT EXISTS FOR.
   *
   * 19:00 UTC on 18 October is already 00:30 on the 19th in Kolkata. Judged in
   * UTC a café's "once a day" would reset at 05:30 local, which is in the
   * middle of their night and halfway through nobody's day.
   */
  it('resolves the day in the program timezone, not UTC', () => {
    const lateUtcEvening = new Date('2026-10-18T19:00:00Z');
    expect(derivePeriodKey(lateUtcEvening, KOLKATA, RewardCapScope.Day)).toBe('2026-10-19');
    expect(derivePeriodKey(lateUtcEvening, 'UTC', RewardCapScope.Day)).toBe('2026-10-18');
  });

  it('puts two events on the same local day in the same slot', () => {
    const morning = new Date('2026-10-19T04:00:00Z'); // 09:30 IST
    const night = new Date('2026-10-19T18:00:00Z'); // 23:30 IST
    expect(derivePeriodKey(morning, KOLKATA, RewardCapScope.Day)).toBe(
      derivePeriodKey(night, KOLKATA, RewardCapScope.Day),
    );
  });

  /**
   * ISO WEEK-YEAR, NOT CALENDAR YEAR.
   *
   * 29 December 2025 is a Monday and belongs to 2026-W01. Using the calendar
   * year would key it as 2025-W01, colliding with the first week of January
   * 2025 — a weekly cap silently doubling for one week every year.
   */
  it('uses the ISO week-year across a new year boundary', () => {
    const lateDecember = new Date('2025-12-29T12:00:00Z');
    expect(derivePeriodKey(lateDecember, 'UTC', RewardCapScope.Week)).toBe('2026-W01');
  });

  it('keeps Monday and Sunday of one ISO week together', () => {
    const monday = new Date('2026-10-19T12:00:00Z');
    const sunday = new Date('2026-10-25T12:00:00Z');
    expect(derivePeriodKey(monday, 'UTC', RewardCapScope.Week)).toBe(
      derivePeriodKey(sunday, 'UTC', RewardCapScope.Week),
    );
  });

  it('starts a new week on the following Monday', () => {
    const sunday = new Date('2026-10-25T12:00:00Z');
    const nextMonday = new Date('2026-10-26T12:00:00Z');
    expect(derivePeriodKey(sunday, 'UTC', RewardCapScope.Week)).not.toBe(
      derivePeriodKey(nextMonday, 'UTC', RewardCapScope.Week),
    );
  });

  /**
   * A DST BOUNDARY MUST NOT SPLIT OR MERGE A LOCAL DAY.
   *
   * On 8 March 2026 New York loses an hour at 02:00. Both instants below are
   * the same local calendar day either side of the jump, and arithmetic on a
   * fixed offset would put them on different days.
   */
  it('keeps one local day together across a spring-forward', () => {
    const before = new Date('2026-03-08T06:00:00Z'); // 01:00 EST
    const after = new Date('2026-03-08T08:00:00Z'); // 04:00 EDT
    expect(derivePeriodKey(before, NEW_YORK, RewardCapScope.Day)).toBe('2026-03-08');
    expect(derivePeriodKey(after, NEW_YORK, RewardCapScope.Day)).toBe('2026-03-08');
  });

  it('keeps one local day together across a fall-back', () => {
    const before = new Date('2026-11-01T05:00:00Z'); // 01:00 EDT
    const after = new Date('2026-11-01T07:00:00Z'); // 03:00 EST
    expect(derivePeriodKey(before, NEW_YORK, RewardCapScope.Day)).toBe('2026-11-01');
    expect(derivePeriodKey(after, NEW_YORK, RewardCapScope.Day)).toBe('2026-11-01');
  });

  it('keys months and years in local time', () => {
    const lateUtc = new Date('2026-10-31T19:00:00Z'); // 1 November in Kolkata
    expect(derivePeriodKey(lateUtc, KOLKATA, RewardCapScope.Month)).toBe('2026-11');
    expect(derivePeriodKey(lateUtc, 'UTC', RewardCapScope.Month)).toBe('2026-10');

    const newYearEve = new Date('2026-12-31T19:00:00Z'); // 1 January in Kolkata
    expect(derivePeriodKey(newYearEve, KOLKATA, RewardCapScope.Year)).toBe('2027');
    expect(derivePeriodKey(newYearEve, 'UTC', RewardCapScope.Year)).toBe('2026');
  });

  it('pads single-digit months and days so keys sort lexically', () => {
    const early = new Date('2026-01-05T12:00:00Z');
    expect(derivePeriodKey(early, 'UTC', RewardCapScope.Day)).toBe('2026-01-05');
    expect(derivePeriodKey(early, 'UTC', RewardCapScope.Month)).toBe('2026-01');
  });
});
