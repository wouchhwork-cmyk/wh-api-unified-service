/**
 * EVERY timestamptz column in this schema stores milliseconds, not microseconds.
 *
 * Postgres defaults to microsecond precision. Nothing in this application can
 * read it: the pg driver hands a timestamptz to a JS `Date`, which holds
 * milliseconds, and every timestamp leaves the API through `toISOString()`,
 * which prints milliseconds. So the extra three digits were invisible
 * everywhere EXCEPT inside SQL comparisons — where they were wrong.
 *
 * That is not a theoretical difference. A keyset cursor is built from a row the
 * driver already rounded, so a row stored at `.993456` yields a cursor saying
 * `.993000`. Compared against the untruncated column, ascending listings repeat
 * the row they meant to resume after, and descending listings SKIP every row
 * sharing that millisecond — silently, which is worse. That is the bug the
 * `(created_at, id)` tiebreaker was supposed to prevent and could not, because
 * the comparison never reached the id.
 *
 * Storing only what can be read makes the whole class of bug unrepresentable,
 * and keeps plain b-tree indexes usable — the alternative, truncating in every
 * query, forfeits the index on exactly the hot tables that need it.
 *
 * Milliseconds are ample: the sub-millisecond ordering of two rows is settled
 * by the id tiebreaker, which is total and does not round.
 *
 * POSTGRES ROUNDS TO THIS PRECISION, IT DOES NOT TRUNCATE. `now()` at
 * .956599 is stored as .957 — up to half a millisecond in the FUTURE. So a row
 * written with `next_attempt_at = now()` is briefly NOT matched by
 * `next_attempt_at <= now()`.
 *
 * Harmless in production, where the writer and the claimer are different worker
 * ticks seconds apart, and invisible to anything polling on a timer. It is only
 * reachable by code fast enough to write and read inside one millisecond, which
 * in practice means a test — two of them were made flaky by this and now say
 * `now() - interval '1 second'` when they mean "already due".
 *
 * ONE THING THIS COSTS, recorded honestly. `updated_at <> created_at` is used
 * as a cheap tripwire for rows written outside the service layer (see
 * schema-guarantees.spec.ts). A modification landing in the same millisecond as
 * the insert is now invisible to it, where microseconds would usually have
 * separated them. The tripwire was always a heuristic rather than a guarantee —
 * the audit trail is the real record — and a listing that silently drops rows
 * is the worse of the two problems by a wide margin.
 */
export const TIMESTAMP_PRECISION = 3;
