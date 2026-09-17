import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/shared/constants';
import { clampLimit } from '@/shared/utils/page-limit';

/**
 * One clamp, replacing three that had already drifted.
 *
 * The cases below are the ones the three copies answered DIFFERENTLY. None is
 * reachable through a controller today — every list schema parses `limit` as a
 * positive integer no larger than MAX_PAGE_SIZE first — so these pin the guard
 * itself rather than a route, which is the only way the drift would ever have
 * been noticed.
 */
describe('clampLimit', () => {
  it('passes an ordinary limit through', () => {
    expect(clampLimit(25)).toBe(25);
  });

  it('caps at the maximum page size', () => {
    expect(clampLimit(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE);
    expect(clampLimit(10_000)).toBe(MAX_PAGE_SIZE);
  });

  it('falls back to the default when no limit was asked for', () => {
    expect(clampLimit(null)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
  });

  describe('the inputs the three copies disagreed on', () => {
    it('floors a fractional limit instead of passing it to SQL', () => {
      // Catalogue's copy returned 7.9 here, which reaches Postgres as LIMIT 7.9.
      expect(clampLimit(7.9)).toBe(7);
    });

    it('never returns NaN', () => {
      // Catalogue's Math.max(NaN, 1) is NaN, and so is Math.min(NaN, MAX).
      expect(clampLimit(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
      expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAGE_SIZE);
    });

    it('treats zero and negatives as absent rather than as a limit', () => {
      expect(clampLimit(0)).toBe(DEFAULT_PAGE_SIZE);
      expect(clampLimit(-5)).toBe(DEFAULT_PAGE_SIZE);
    });

    it('rounds a limit between zero and one up to the default, not down to nothing', () => {
      // Flooring alone would give LIMIT 0 — a page that can never advance.
      expect(clampLimit(0.5)).toBe(DEFAULT_PAGE_SIZE);
    });
  });
});
