import { describe, expect, it } from 'vitest';
import { TimeWindowCondition } from '@/modules/rewards/conditions/time-window.condition';
import type { ConditionContext } from '@/modules/rewards/conditions/condition.types';
import { RewardConditionKind } from '@/shared/enums';

const condition = new TimeWindowCondition();

function ctx(at: string, timezone = 'Asia/Kolkata'): ConditionContext {
  return {
    enterpriseId: 1,
    customerId: 1,
    occurredAtUtc: new Date(at),
    timezone,
    content: null,
    customerFirstSeenAt: null,
  };
}

function slots(...list: { days: number[]; start: string; end: string }[]) {
  return {
    conditionKind: RewardConditionKind.TimeWindow as const,
    config: { slots: list },
  };
}

/**
 * Happy hours. Every case here is one the obvious implementation gets wrong.
 */
describe('TimeWindowCondition', () => {
  // Monday 2026-10-19, 15:30 IST = 10:00 UTC
  const MONDAY_1530_IST = '2026-10-19T10:00:00Z';

  it('passes inside the slot', () => {
    const rule = slots({ days: [1], start: '15:00', end: '17:00' });
    expect(condition.check(rule, ctx(MONDAY_1530_IST))).toBe(true);
  });

  it('fails outside the hours', () => {
    const rule = slots({ days: [1], start: '18:00', end: '21:00' });
    expect(condition.check(rule, ctx(MONDAY_1530_IST))).toBe(false);
  });

  it('fails on the wrong day', () => {
    const rule = slots({ days: [2, 4], start: '15:00', end: '17:00' });
    expect(condition.check(rule, ctx(MONDAY_1530_IST))).toBe(false);
  });

  /** The end is EXCLUSIVE, so two adjacent slots cannot both match one instant. */
  it('excludes the end boundary and includes the start', () => {
    const atFive = '2026-10-19T11:30:00Z'; // 17:00 IST
    const atThree = '2026-10-19T09:30:00Z'; // 15:00 IST
    const rule = slots({ days: [1], start: '15:00', end: '17:00' });
    expect(condition.check(rule, ctx(atThree))).toBe(true);
    expect(condition.check(rule, ctx(atFive))).toBe(false);
  });

  /**
   * SEVERAL SLOTS IN ONE DAY — lunch AND dinner.
   *
   * A single start/end pair could not express this, which is why slots are a
   * list that ORs.
   */
  it('matches any slot in a multi-slot day', () => {
    const rule = slots(
      { days: [1], start: '12:00', end: '14:00' },
      { days: [1], start: '18:00', end: '21:00' },
    );
    const lunch = ctx('2026-10-19T07:00:00Z'); // 12:30 IST
    const dinner = ctx('2026-10-19T13:00:00Z'); // 18:30 IST
    const between = ctx('2026-10-19T10:30:00Z'); // 16:00 IST

    expect(condition.check(rule, lunch)).toBe(true);
    expect(condition.check(rule, dinner)).toBe(true);
    expect(condition.check(rule, between)).toBe(false);
  });

  /**
   * THE MIDNIGHT WRAP, AND ITS SECOND HALF.
   *
   * Friday 22:00 to 02:00 is configured once as a Friday slot. The classic bug
   * is matching only the late-Friday half, so the window silently stops working
   * at midnight — which is the half the customers are actually using.
   */
  describe('a slot that wraps past midnight', () => {
    const rule = slots({ days: [5], start: '22:00', end: '02:00' });

    it('matches late on the named day', () => {
      expect(condition.check(rule, ctx('2026-10-23T17:00:00Z'))).toBe(true); // Fri 22:30 IST
    });

    it('matches early on the day AFTER the named day', () => {
      expect(condition.check(rule, ctx('2026-10-23T19:30:00Z'))).toBe(true); // Sat 01:00 IST
    });

    it('does not match after the window closes', () => {
      expect(condition.check(rule, ctx('2026-10-23T21:00:00Z'))).toBe(false); // Sat 02:30 IST
    });

    it('does not match before it opens', () => {
      expect(condition.check(rule, ctx('2026-10-23T16:00:00Z'))).toBe(false); // Fri 21:30 IST
    });

    /** Sunday wraps into Monday: day 7 then day 1, not day 8. */
    it('wraps correctly from Sunday into Monday', () => {
      const sundayRule = slots({ days: [7], start: '23:00', end: '01:00' });
      expect(condition.check(sundayRule, ctx('2026-10-18T19:00:00Z'))).toBe(true); // Mon 00:30 IST
    });
  });

  /**
   * A WALL-CLOCK WINDOW DOES NOT MOVE WITH DST.
   *
   * 15:30 local in New York is 19:30 UTC in March and 20:30 UTC in January.
   * Both must match a 15:00-17:00 window; an implementation using a fixed
   * offset passes one and fails the other.
   */
  it('holds 15:00-17:00 local across a DST change', () => {
    const rule = slots({ days: [1, 2, 3, 4, 5], start: '15:00', end: '17:00' });
    const winter = ctx('2026-01-19T20:30:00Z', 'America/New_York'); // 15:30 EST, Monday
    const summer = ctx('2026-07-20T19:30:00Z', 'America/New_York'); // 15:30 EDT, Monday

    expect(condition.check(rule, winter)).toBe(true);
    expect(condition.check(rule, summer)).toBe(true);
  });

  /** Midnight renders as 24 in en-GB; unnormalised it lands past every window. */
  it('treats local midnight as 00:00, not 24:00', () => {
    const rule = slots({ days: [1], start: '00:00', end: '06:00' });
    expect(condition.check(rule, ctx('2026-10-18T18:30:00Z'))).toBe(true); // Mon 00:00 IST
  });
  /**
   * THE LAST MINUTE OF THE DAY, which half-open arithmetic quietly drops.
   *
   * A window is `[start, end)` everywhere else, and that is right: 18:00 to
   * 21:00 must not also award at 21:00 sharp, because that is where the next
   * window begins. 23:59 is the exception, and it is a missing number rather
   * than a special case — there is no 24:00 to type, so 23:59 is how somebody
   * writes "until the end of the day".
   */
  describe('a window ending at 23:59', () => {
    // Monday 2026-10-19 23:59 IST = 18:29 UTC
    const MONDAY_2359_IST = '2026-10-19T18:29:00Z';
    // Tuesday 2026-10-20 00:00 IST = 18:30 UTC on the Monday
    const TUESDAY_0000_IST = '2026-10-19T18:30:00Z';

    it('includes 23:59 itself', () => {
      const rule = slots({ days: [1], start: '18:00', end: '23:59' });
      expect(condition.check(rule, ctx(MONDAY_2359_IST))).toBe(true);
    });

    /**
     * THE HANDOVER. Monday ending 23:59 and Tuesday starting 00:00 have to
     * join with no gap — read exclusively, the minute 23:59:00 to 23:59:59
     * belonged to neither and a customer in it earned nothing.
     */
    it('hands over to a 00:00 slot on the next day with no gap', () => {
      const rule = slots(
        { days: [1], start: '18:00', end: '23:59' },
        { days: [2], start: '00:00', end: '02:00' },
      );
      expect(condition.check(rule, ctx(MONDAY_2359_IST)), 'the last minute of Monday').toBe(true);
      expect(condition.check(rule, ctx(TUESDAY_0000_IST)), 'the first minute of Tuesday').toBe(
        true,
      );
    });

    /** And it does not leak into the next day on its own. */
    it('stops at midnight when the next day has no slot', () => {
      const rule = slots({ days: [1], start: '18:00', end: '23:59' });
      expect(condition.check(rule, ctx(TUESDAY_0000_IST))).toBe(false);
    });
  });

  /**
   * A TICKED DAY WITH NO HOURS MEANS ALL OF IT.
   *
   * This is what `scheduleToConditions` writes, and it was written as
   * 00:00–00:00 — which the ordinary branch reads as
   * `minutes >= 0 && minutes < 0`, false at every instant. A day somebody
   * ticked matched nothing at all, and the test covering it asserted the
   * stored shape rather than whether it ever fired.
   */
  describe('the whole-day window', () => {
    const WHOLE_DAY = { days: [1], start: '00:00', end: '23:59' };

    it('matches at the first minute', () => {
      // Monday 00:00 IST = Sunday 18:30 UTC
      expect(condition.check(slots(WHOLE_DAY), ctx('2026-10-18T18:30:00Z'))).toBe(true);
    });

    it('matches in the middle', () => {
      expect(condition.check(slots(WHOLE_DAY), ctx(MONDAY_1530_IST))).toBe(true);
    });

    it('matches at the last minute', () => {
      expect(condition.check(slots(WHOLE_DAY), ctx('2026-10-19T18:29:00Z'))).toBe(true);
    });

    it('does not match another day', () => {
      // Tuesday 15:30 IST
      expect(condition.check(slots(WHOLE_DAY), ctx('2026-10-20T10:00:00Z'))).toBe(false);
    });
  });
});
