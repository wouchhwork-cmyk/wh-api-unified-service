import type { ValueTransformer } from 'typeorm';

/**
 * BIGINT ids are `number` in application code, made safe explicitly.
 *
 * The `pg` driver returns int8 as a STRING, because a 64-bit integer can exceed
 * Number.MAX_SAFE_INTEGER. Left untreated, every id silently becomes a string
 * and `===` against a number fails. Converting here — and THROWING past the safe
 * range — turns a theoretical overflow at ~9 quadrillion rows into a loud error
 * instead of silent precision loss (backend-design.md §5).
 */
export const bigintTransformer: ValueTransformer = {
  to(value: number | null | undefined): number | null | undefined {
    return value;
  },

  from(value: string | number | null): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(
        `BIGINT value ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be ` +
          'represented without precision loss. The id strategy must change before this point.',
      );
    }
    return parsed;
  },
};

/** Postgres NUMERIC/BIGINT counters that are read but never compared as ids. */
export const bigintCountTransformer: ValueTransformer = {
  to(value: number | null | undefined): number | null | undefined {
    return value;
  },
  from(value: string | number | null): number {
    if (value === null || value === undefined) return 0;
    return typeof value === 'number' ? value : Number(value);
  },
};
