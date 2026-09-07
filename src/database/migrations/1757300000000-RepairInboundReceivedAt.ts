import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pulls the year-58651 ledger rows back to the dates they should have had.
 *
 * `meta-webhook.service.ts` multiplied every `entry.time` by 1000. A `changes`
 * entry does send seconds, so mentions and comments stored correctly; a
 * `messaging` entry sends MILLISECONDS, so every Instagram DM was stored a
 * thousand times too far into the future — 1788705985749 became 58651-11-02
 * instead of 2026-09-06 (docs/platform-limitations.md §8.1). 72 rows carry such
 * a date. `received_at` is what orders recovered history against
 * live events, so leaving them would keep every DM in the affected window
 * sorting after everything that will ever happen.
 *
 * The code no longer produces these — it normalises by magnitude now — and this
 * repairs the history behind that fix. Deploy order does not matter: the two
 * changes are independent, and a row written by the old code after this ran
 * would simply still be wrong rather than corrupted differently.
 *
 * THE WHERE CLAUSE IS THE SAFETY. Only rows dated more than a year into the
 * future are touched. A genuine `received_at` is a platform timestamp for
 * something that has already happened, so no correct row can be in that set —
 * not a clock-skewed one, not a backfilled one, not one from a platform running
 * ahead. The multiplication overshoots by a factor of 1000, which puts every
 * corrupted row tens of thousands of years out, so the margin between the two
 * populations is not close.
 *
 * DATA ONLY — no schema change, nothing to sequence. Dividing by 1000 is exact
 * for these values in double precision (a repaired instant needs 13 significant
 * digits; a double carries 15), and the repaired rows immediately fall outside
 * the WHERE clause, so running it twice is the same as running it once.
 */
export class RepairInboundReceivedAt1757300000000 implements MigrationInterface {
  name = 'RepairInboundReceivedAt1757300000000';

  public async up(q: QueryRunner): Promise<void> {
    /*
     * The second predicate is belt and braces: it refuses to write a value that
     * is not itself plausible. If a row were wrong by some factor other than
     * 1000 — a shape this repair does not model — dividing would move it
     * somewhere else wrong, and the row is better left visibly broken than
     * quietly given a believable date.
     *
     * Unindexed, and deliberately so: this is a one-shot repair over a table
     * whose corrupted population is a handful of rows, and an index built for a
     * predicate that will never be evaluated again is pure write overhead.
     */
    await q.query(`
      UPDATE inbound_events
         SET received_at = to_timestamp(extract(epoch FROM received_at) / 1000)
       WHERE received_at > now() + interval '1 year'
         AND to_timestamp(extract(epoch FROM received_at) / 1000)
             BETWEEN timestamptz '2004-01-01 00:00:00+00' AND now() + interval '1 year'
    `);
  }

  /**
   * Nothing to undo. Re-multiplying would restore dates that were never true,
   * and the rows this touched are identifiable only BY being wrong — after the
   * repair there is no marker saying which they were, so an inverse could not
   * be scoped to them anyway.
   */
  public async down(): Promise<void> {
    return Promise.resolve();
  }
}
