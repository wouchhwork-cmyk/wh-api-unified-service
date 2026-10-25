import { RewardCapScope } from '@/shared/enums';

/**
 * Which cap slot an event falls into.
 *
 * RESOLVED IN THE PROGRAM'S TIMEZONE, not UTC and not the server's. A Mumbai
 * café's "once a day" must not reset at 05:30 local, and a program running in
 * two countries must not share a slot across them.
 *
 * The key is stored on both the counter and the award, so "why didn't I get my
 * points?" is answered by one row rather than an investigation.
 */
export function derivePeriodKey(at: Date, timezone: string, scope: RewardCapScope): string | null {
  if (scope === RewardCapScope.None) return null;
  if (scope === RewardCapScope.Lifetime) return 'LIFETIME';

  const { year, month, day } = localYmd(at, timezone);

  switch (scope) {
    case RewardCapScope.Day:
      return `${year}-${pad(month)}-${pad(day)}`;
    case RewardCapScope.Week:
      return isoWeekKey(year, month, day);
    case RewardCapScope.Month:
      return `${year}-${pad(month)}`;
    case RewardCapScope.Year:
      return String(year);
    default:
      return null;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The calendar date as the program's timezone sees it.
 *
 * `en-CA` renders ISO-ordered YYYY-MM-DD, which avoids parsing a localised
 * order. Done with Intl rather than offset arithmetic because an offset is
 * wrong twice a year, and a DST boundary inside a daily cap would silently
 * merge or split a day.
 */
function localYmd(at: Date, timezone: string): { year: number; month: number; day: number } {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(at)
    .split('-')
    .map(Number);

  return { year: year ?? 0, month: month ?? 1, day: day ?? 1 };
}

/**
 * ISO-8601 week: weeks start Monday, and week 1 is the one containing 4 January.
 *
 * The year in the key is the ISO WEEK-YEAR, which is not always the calendar
 * year — 29 December 2025 is 2026-W01. Using the calendar year would put two
 * different weeks under one key across every new year, which is a cap silently
 * doubling for one week a year.
 */
function isoWeekKey(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = date.getUTCDay() || 7; // Sunday 0 becomes 7
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek); // move to the week's Thursday
  const weekYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstDayOfWeek = firstThursday.getUTCDay() || 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstDayOfWeek);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${weekYear}-W${pad(week)}`;
}
