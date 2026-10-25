import { Injectable } from '@nestjs/common';
import { RewardConditionKind } from '@/shared/enums';
import type { ConditionContext, ConditionHandler, ConditionOf } from './condition.types';

/** Minutes since local midnight. */
function toMinutes(wallClock: string): number {
  const [h, m] = wallClock.split(':');
  return Number(h) * 60 + Number(m);
}

/** The last minute of a day, 23:59. */
const LAST_MINUTE_OF_DAY = 23 * 60 + 59;
/** One past it, which is midnight — the value a window needs to reach it. */
const END_OF_DAY = 24 * 60;

/**
 * An end time, with `23:59` read as the end of the day.
 *
 * A window is otherwise half-open — `[start, end)` — which is the right shape
 * for every other value: 18:00 to 21:00 should not also award at 21:00 sharp,
 * because the next window starts there.
 *
 * 23:59 IS THE EXCEPTION, and it is not a special case so much as a missing
 * number. There is no 24:00 to type: an `<input type="time">` stops at 23:59,
 * so that is how a person writes "until the end of the day". Read exclusively
 * it instead means "until 23:58:59", quietly dropping the last minute —
 * invisible on its own, and visible as a hole the moment the next day starts
 * at 00:00 and the two are supposed to join.
 *
 * So a window ending 23:59 runs to midnight, and 23:59 to 00:00 is seamless.
 * Nobody types 23:59 meaning "all but the last minute".
 */
function endMinute(wallClock: string): number {
  const end = toMinutes(wallClock);
  return end === LAST_MINUTE_OF_DAY ? END_OF_DAY : end;
}

/**
 * Resolves an instant into the PROGRAM's local day and clock.
 *
 * `Intl.DateTimeFormat` rather than arithmetic on an offset, because a
 * recurring window is a WALL-CLOCK fact: 6pm Tuesday means 6pm local in March
 * and in November. Store or compute an offset and DST silently shifts every
 * window twice a year.
 */
function localParts(at: Date, timezone: string): { isoDay: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const WEEKDAYS: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  // 'en-GB' with hour12:false renders midnight as 24; normalise to 0 so a
  // 00:00 boundary compares correctly rather than landing past every window.
  const hour = Number(pick('hour')) % 24;
  return {
    isoDay: WEEKDAYS[pick('weekday')] ?? 0,
    minutes: hour * 60 + Number(pick('minute')),
  };
}

/**
 * Day-of-week plus local clock slots.
 *
 * SLOTS OR WITHIN THIS CONDITION; conditions AND at the rule level. That is the
 * only OR in the whole design, and it is contained inside one handler rather
 * than being a general boolean tree — which is what keeps us out of the batched
 * materialisation pipeline an open predicate language forces.
 *
 * This used to be its own table with about twenty lines of EXTRACT(ISODOW) and
 * wrap-around comparison inlined in the claim query. As a condition it is one
 * pure function, testable without a database, and a rule can carry its own
 * happy hour without needing a second program.
 */
@Injectable()
export class TimeWindowCondition implements ConditionHandler<RewardConditionKind.TimeWindow> {
  readonly kind = RewardConditionKind.TimeWindow as const;

  check(condition: ConditionOf<RewardConditionKind.TimeWindow>, ctx: ConditionContext): boolean {
    /*
     * FAILS CLOSED with no timezone. "Tuesday 6pm to 9pm" has no meaning
     * until somebody says where, and guessing a zone would silently open or
     * close a happy hour by hours. Rule creation refuses a window while the
     * business has no timezone; arriving here means it was cleared afterwards,
     * and not awarding is the recoverable direction.
     */
    if (ctx.timezone === null) return false;

    const { isoDay, minutes } = localParts(ctx.occurredAtUtc, ctx.timezone);

    return condition.config.slots.some((slot) => {
      const start = toMinutes(slot.start);
      const end = endMinute(slot.end);

      if (start <= end) {
        return slot.days.includes(isoDay) && minutes >= start && minutes < end;
      }

      /*
       * The slot WRAPS past midnight — Friday 22:00 to 02:00.
       *
       * Configured once as a Friday slot, not as two rows an enterprise has to
       * reason about. So it matches late on the named day, OR early on the day
       * AFTER the named day. Missing that second half is the classic version of
       * this bug: a Friday-night window silently stops working at midnight.
       */
      const previousDay = isoDay === 1 ? 7 : isoDay - 1;
      return (
        (slot.days.includes(isoDay) && minutes >= start) ||
        (slot.days.includes(previousDay) && minutes < end)
      );
    });
  }
}
