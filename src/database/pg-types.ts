import { types } from 'pg';

/**
 * BIGINT arrives as a STRING from the pg driver, because a 64-bit integer can
 * exceed Number.MAX_SAFE_INTEGER. Left untreated every id is silently a string
 * and `===` against a number fails.
 *
 * Registering one parser converts int8 to number everywhere — and THROWS past
 * the safe range, turning a theoretical overflow at ~9 quadrillion rows into a
 * loud error rather than silent precision loss (backend-design.md §5).
 *
 * Imported for its side effect by data-source.ts, before any connection opens.
 */
const PG_INT8 = 20;

types.setTypeParser(PG_INT8, (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `BIGINT ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be represented ` +
        'without precision loss. The id strategy must change before this point.',
    );
  }
  return parsed;
});
