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
 */
export const TIMESTAMP_PRECISION = 3;
