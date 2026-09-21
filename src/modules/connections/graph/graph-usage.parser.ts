import { MetaUsageMeter } from '@/shared/enums';

/**
 * Reading Meta's rate-limit headers.
 *
 * ONE MODULE OWNS THIS. Two questions are asked of the same headers — "how long
 * must we wait" on an error, and "where do we stand" on every response — and
 * answering them with two parsers is how they drift apart.
 *
 * WHAT THE HEADERS ACTUALLY CONTAIN, measured against the live API on
 * 21 Sep 2026 with our own app and cross-checked with Meta's documentation:
 *
 *   x-app-usage                 {"call_count":12,"total_cputime":0,"total_time":0}
 *   x-business-use-case-usage   {"<id>":[{"type":"instagram","call_count":1,...}]}
 *
 * Three things about them are counter-intuitive enough to be worth stating:
 *
 *   1. EVERY FIGURE IS A PERCENTAGE, not a count. Six consecutive calls to one
 *      edge left `call_count` at 1. Throttling begins at 100.
 *   2. THE TWO HEADERS ARE MUTUALLY EXCLUSIVE in practice. An app or user token
 *      returns the app header; a Page or Instagram token returns the business
 *      one. Meta documents that where both could apply, the business meter is
 *      applied instead — and ninety business-token calls moved our app counter
 *      not at all.
 *   3. `estimated_time_to_regain_access` IS NOT A HEALTH SIGNAL. Meta's own
 *      examples show 0 against pools sitting at 95% and 97%. It means "not
 *      blocked right now", never "safe". Only the percentage says how much room
 *      is left.
 */

/** One pool's position, as Meta reported it on a single response. */
export interface MetaUsageReading {
  readonly meter: MetaUsageMeter;
  /** Meta's `type`. NULL for the app meter, which has no product breakdown. */
  readonly product: string | null;
  /** The id Meta keyed the entry under. NULL for the app meter. */
  readonly metaBusinessId: string | null;
  /** Percentage of the call allowance used. NULL when Meta omitted it. */
  readonly callPct: number | null;
  readonly cpuPct: number | null;
  readonly timePct: number | null;
  /** Minutes until calls stop being refused. See point 3 above. */
  readonly regainMinutes: number | null;
}

/**
 * Headers, as either a `fetch` Headers or a plain object.
 *
 * The plain-object form is what makes this testable without constructing a
 * Response, and it is also what a test fixture of a real Meta response looks
 * like when pasted in.
 */
export type UsageHeaderSource = Headers | Record<string, string | undefined>;

const APP_HEADER = 'x-app-usage';
const BUSINESS_HEADER = 'x-business-use-case-usage';

/**
 * Also read when looking for a wait time, never recorded as a pool.
 *
 * This app makes no Marketing API calls, so it should never appear. It is
 * tolerated here rather than modelled because the cost is one header lookup and
 * the alternative — discovering on the day somebody adds an ads feature that we
 * ignored Meta's own back-off advice — is not worth saving it.
 */
const AD_ACCOUNT_HEADER = 'x-ad-account-usage';

function headerValue(source: UsageHeaderSource, name: string): string | null {
  if (typeof (source as Headers).get === 'function') {
    return (source as Headers).get(name);
  }
  const record = source as Record<string, string | undefined>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

/**
 * A header's JSON, or null.
 *
 * NEVER THROWS. A malformed header must not turn a successful response into a
 * parse error, nor a rate limit into an unrecognised failure — the body is the
 * answer, and this is commentary on it.
 */
function readJsonHeader(source: UsageHeaderSource, name: string): unknown {
  const raw = headerValue(source, name);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * A percentage, or null if it is not one.
 *
 * Absence is preserved as null rather than coerced to 0 for the reason the
 * entity documents: a missing figure means we cannot see our position, and
 * reporting that as "0% used" would show a clear budget at the one moment it is
 * least safe to assume one.
 */
function percentage(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function positiveMinutes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function readingFrom(
  meter: MetaUsageMeter,
  metaBusinessId: string | null,
  entry: Record<string, unknown>,
): MetaUsageReading {
  const product = typeof entry.type === 'string' && entry.type.length > 0 ? entry.type : null;
  return {
    meter,
    product,
    metaBusinessId,
    callPct: percentage(entry.call_count),
    cpuPct: percentage(entry.total_cputime),
    timePct: percentage(entry.total_time),
    regainMinutes: positiveMinutes(entry.estimated_time_to_regain_access),
  };
}

/**
 * Every pool the response said something about.
 *
 * An empty array means Meta sent no usage header. That is a real and documented
 * case — the header appears on endpoints receiving enough requests — and it
 * must be recorded as "we did not learn anything", not as a reading of zero.
 */
export function parseUsageReadings(source: UsageHeaderSource): MetaUsageReading[] {
  const readings: MetaUsageReading[] = [];

  const app = readJsonHeader(source, APP_HEADER);
  if (typeof app === 'object' && app !== null && !Array.isArray(app)) {
    readings.push(readingFrom(MetaUsageMeter.App, null, app as Record<string, unknown>));
  }

  const business = readJsonHeader(source, BUSINESS_HEADER);
  if (typeof business === 'object' && business !== null && !Array.isArray(business)) {
    for (const [metaBusinessId, value] of Object.entries(business as Record<string, unknown>)) {
      // Documented and observed as an array of one entry per pool. The single
      // object form is tolerated because it costs one branch and the shape is
      // Meta's to change.
      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue;
        readings.push(
          readingFrom(
            MetaUsageMeter.BusinessUseCase,
            metaBusinessId,
            entry as Record<string, unknown>,
          ),
        );
      }
    }
  }

  return readings;
}

/**
 * Meta's own estimate of when a throttled app may call again, in minutes.
 *
 * THE LONGEST across every pool named, because a shorter wait would still be
 * throttled — and calling while throttled extends the block, which Meta states
 * explicitly. Null means Meta did not say, and the caller falls back to its own
 * park window.
 */
export function longestRegainMinutes(source: UsageHeaderSource): number | null {
  let longest: number | null = null;

  const consider = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    const estimate = positiveMinutes(
      (value as { estimated_time_to_regain_access?: unknown }).estimated_time_to_regain_access,
    );
    if (estimate === null) return;
    longest = longest === null ? estimate : Math.max(longest, estimate);
  };

  for (const name of [APP_HEADER, BUSINESS_HEADER, AD_ACCOUNT_HEADER]) {
    const parsed = readJsonHeader(source, name);
    if (parsed === null) continue;

    // The app header is flat; the other two nest an array per business id.
    consider(parsed);
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (Array.isArray(value)) value.forEach(consider);
        else consider(value);
      }
    }
  }

  return longest;
}
