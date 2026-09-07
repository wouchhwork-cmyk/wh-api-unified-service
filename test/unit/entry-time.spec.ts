import { describe, expect, it } from 'vitest';
import { MAX_PLAUSIBLE_ENTRY_TIME_MS, normalizeEntryTime } from '@/modules/connections/entry-time';

/**
 * The values below are REAL ones taken off the wire on 2026-09-06, not invented:
 * the service multiplied every `entry.time` by 1000, which is right for a
 * `changes` entry and wrong by a factor of a thousand for a `messaging` one, and
 * 72 ledger rows ended up dated in the year 58649 or later
 * (docs/platform-limitations.md §8.1).
 *
 * Every case is a fixed number and a fixed expected instant — nothing here reads
 * the clock, so the suite cannot start failing on a particular day.
 */
describe('normalizing a Meta entry.time', () => {
  it('reads a messaging entry as milliseconds', () => {
    // Observed on an Instagram DM delivery. `* 1000` made this 58651-11-02.
    expect(normalizeEntryTime(1788705985749)?.toISOString()).toBe('2026-09-06T14:46:25.749Z');
  });

  it('still reads a changes entry as seconds', () => {
    // Mention event 1514, which stored CORRECTLY under the old code. The fix
    // must not regress the entries that already worked.
    expect(normalizeEntryTime(1788727023)?.toISOString()).toBe('2026-09-06T20:37:03.000Z');
  });

  it('accepts a plain integer second value with no sub-second part', () => {
    expect(normalizeEntryTime(1788705985)?.toISOString()).toBe('2026-09-06T14:46:25.000Z');
  });

  it('returns null when there is no time on the entry', () => {
    // Not every entry carries one, and that is not an error.
    expect(normalizeEntryTime(undefined)).toBeNull();
    expect(normalizeEntryTime(null)).toBeNull();
  });

  it('returns null for zero', () => {
    // The epoch itself is a placeholder, never a delivery.
    expect(normalizeEntryTime(0)).toBeNull();
  });

  it('returns null for a negative value', () => {
    expect(normalizeEntryTime(-1)).toBeNull();
    expect(normalizeEntryTime(-1788705985749)).toBeNull();
  });

  it('returns null for a non-finite value', () => {
    expect(normalizeEntryTime(Number.NaN)).toBeNull();
    expect(normalizeEntryTime(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeEntryTime(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('returns null for a value that is absurd in either unit', () => {
    /*
     * The corruption this fixes, arriving pre-multiplied: 1788705985749 * 1000
     * is the year 58651. Null rather than a Date, because an implausible
     * received_at poisons every ordering it takes part in — and rather than an
     * Invalid Date, which is still truthy and would reach the insert.
     */
    expect(normalizeEntryTime(1788705985749000)).toBeNull();
    expect(normalizeEntryTime(Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it('returns null for a value that is not a number at all', () => {
    // Meta's payloads are untyped JSON; a string here has been seen on other
    // fields and must not become an Invalid Date.
    expect(normalizeEntryTime('1788705985749')).toBeNull();
    expect(normalizeEntryTime({})).toBeNull();
  });

  it('reads the boundary value itself as seconds', () => {
    // At the boundary, still seconds: 2100-01-01, the last instant a
    // second-epoch is considered plausible.
    const boundarySeconds = MAX_PLAUSIBLE_ENTRY_TIME_MS / 1000;
    expect(normalizeEntryTime(boundarySeconds)?.toISOString()).toBe('2100-01-01T00:00:00.000Z');
  });

  it('reads one above the boundary as milliseconds', () => {
    /*
     * The unit flips here, and the resulting 1970 date is the honest reading:
     * no live webhook can produce a number in this band — a second-epoch does
     * not reach it until 2100, a millisecond-epoch left it in February 1970 —
     * so the flip can never catch a real timestamp.
     */
    const justAbove = MAX_PLAUSIBLE_ENTRY_TIME_MS / 1000 + 1;
    expect(normalizeEntryTime(justAbove)?.toISOString()).toBe('1970-02-17T11:34:04.801Z');
  });

  it('accepts a millisecond value right at the ceiling and rejects one past it', () => {
    expect(normalizeEntryTime(MAX_PLAUSIBLE_ENTRY_TIME_MS)?.toISOString()).toBe(
      '2100-01-01T00:00:00.000Z',
    );
    expect(normalizeEntryTime(MAX_PLAUSIBLE_ENTRY_TIME_MS + 1)).toBeNull();
  });
});
