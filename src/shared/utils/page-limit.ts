import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/shared/constants';

/**
 * The one page size clamp.
 *
 * Like the cursor codec beside it, this was written three times — inbox,
 * catalogue and the platform console — and the three had already drifted.
 * Catalogue's `Math.min(Math.max(limit, 1), MAX_PAGE_SIZE)` returns NaN for a
 * non-finite input and never floors, so a fractional limit would have reached
 * SQL as `LIMIT 7.9`; the other two floor and fall back to the default.
 *
 * NOTHING REACHES THAT TODAY, and that is the point. Every list schema parses
 * `limit` as `z.coerce.number().int().positive().max(MAX_PAGE_SIZE)` before it
 * arrives, so the drift was invisible — a guard whose divergence only shows up
 * the first time a caller reaches it from somewhere without a schema in front.
 * One answer is cheaper than three that agree by coincidence.
 */
export function clampLimit(limit: number | null | undefined): number {
  if (limit === null || limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}
