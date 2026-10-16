/**
 * Reading `entry.time` off a Meta webhook entry, whose UNIT Meta does not state
 * and does not keep consistent (docs/platform-limitations.md §8.1).
 *
 * A MODULE OF ITS OWN, next to messaging-event.ts and for the same reason: it is
 * a pure function over a payload, encoding a rule that has already been wrong
 * once, so it needs testing without dragging in the Nest dependency graph.
 *
 * THE FAILURE. The service multiplied `entry.time` by 1000 unconditionally. A
 * `changes` entry (mentions, comments) does send seconds, so those stored
 * correctly — mention event 1514 landed at a sane 2026-09-06 20:37:03. But a
 * `messaging` entry (Instagram DMs) sends MILLISECONDS: 1788705985749 was
 * observed on the wire for 2026-09-06T14:46:25Z, and multiplying it gave the
 * year 58651. 72 ledger rows carry such a date. `received_at` is what orders
 * recovered history against live events, so this is not cosmetic.
 *
 * NORMALISED BY MAGNITUDE, NOT BY ENTRY TYPE. Branching on `changes` vs
 * `messaging` would encode today's two cases and be wrong again the first time
 * Meta adds a third, or changes the unit on one of these two without saying so —
 * which is exactly what happened here. The number itself says which unit it is,
 * so ask the number.
 */

/**
 * The unit boundary, and the plausibility ceiling. One constant, because they
 * are the same question asked twice.
 *
 * A value at or below this is read as SECONDS; above it, as MILLISECONDS.
 * The band either side is enormous, which is what makes reading the magnitude
 * safe rather than a guess:
 *
 *   - A second-epoch only reaches this number in the year 2100. Live traffic
 *     sits near 1.79e9 — three orders of magnitude below.
 *   - A millisecond-epoch only falls to this number in February 1970. Live
 *     traffic sits near 1.79e12 — nearly three orders of magnitude above.
 *
 * Nothing a Meta webhook can deliver lands in between, so no real timestamp is
 * near enough to the boundary to be misread on either side.
 *
 * It doubles as the ceiling: once normalised, a timestamp past the year 2100 is
 * not a slow delivery, it is corruption — the year-58651 rows this fixes are
 * exactly that shape — and storing it would poison every ordering it takes part
 * in. Null instead, which `received_at` already accepts.
 */
export const MAX_PLAUSIBLE_ENTRY_TIME_MS = Date.UTC(2100, 0, 1);
const MAX_PLAUSIBLE_ENTRY_TIME_SECONDS = MAX_PLAUSIBLE_ENTRY_TIME_MS / 1000;
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Meta's `entry.time` as a Date, or null when it cannot be one.
 *
 * Null rather than an Invalid Date for every rejected input: an Invalid Date is
 * still a Date, so it passes a truthiness check, reaches the insert, and becomes
 * either a driver error at the very end of ingestion or — worse — a NULL nobody
 * attributes to a bad timestamp.
 */
export function normalizeEntryTime(raw: unknown): Date | null {
  // Absent is normal: not every entry carries a time. Zero and negatives are
  // not — an epoch at or before 1970 is a placeholder or a sign error, never a
  // webhook that just arrived.
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;

  const milliseconds = raw > MAX_PLAUSIBLE_ENTRY_TIME_SECONDS ? raw : raw * MILLISECONDS_PER_SECOND;

  if (milliseconds > MAX_PLAUSIBLE_ENTRY_TIME_MS) return null;

  return new Date(milliseconds);
}
