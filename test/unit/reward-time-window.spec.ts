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
});
