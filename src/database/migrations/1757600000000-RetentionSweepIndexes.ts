import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the two retention sweeps use indexes. They never have.
 *
 * Both were WRITTEN to. `session.repository.ts` had already been split into two
 * statements to escape an OR, with a comment claiming each half then used an
 * index — and `EXPLAIN` with `enable_seqscan = off` says otherwise: neither
 * half could use one, so the split bought nothing. The sweeps are sequential
 * scans of `sessions` and `verifications` on every run, on tables that grow
 * with every login and every verification code ever sent.
 *
 * Three changes, each answering one predicate the planner could not serve:
 *
 * 1. `sessions_revoked_idx` — nothing indexed `revoked_at` at all.
 *
 * 2. `verifications_consumed_idx` — likewise for `consumed_at`.
 *
 * 3. `verifications_expiry_idx` is WIDENED, by dropping `is_deleted = false`
 *    from its predicate. A partial index can only serve a query that repeats
 *    its predicate, and the sweep must reach soft-deleted rows too — those are
 *    exactly the rows retention exists to remove. The narrower index served
 *    only the live-verification lookup; the wider one still serves it, with a
 *    recheck, so this replaces an index rather than adding one.
 *
 * The queries move to match, in the same commit: a sweep half now names
 * `revoked_at IS NULL` / `consumed_at IS NULL` so the partial indexes apply.
 * That shifts retention to run from the LATER of the two events on a row — a
 * session revoked yesterday but expired last month is kept until the
 * revocation ages out. Deliberate: "delete N days after the last thing that
 * happened to this row" is the rule people expect of retention, and the old
 * behaviour deleted it N days after the earlier one.
 *
 * EXPAND ONLY. Indexes are additive, no column changes, no backfill. The
 * widened index is created under a new name and the old one dropped after, so
 * no window exists without an index behind that predicate. Declared in
 * schema-objects.ts too, so a database built by `db:sync` gets the same shape —
 * the split every index in this repo has.
 */
export class RetentionSweepIndexes1757600000000 implements MigrationInterface {
  name = 'RetentionSweepIndexes1757600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS sessions_revoked_idx
      ON sessions (revoked_at)
      WHERE revoked_at IS NOT NULL
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS verifications_consumed_idx
      ON verifications (consumed_at)
      WHERE consumed_at IS NOT NULL
    `);

    // New name first, old name second: the predicate is never unindexed.
    await q.query(`
      CREATE INDEX IF NOT EXISTS verifications_unconsumed_expiry_idx
      ON verifications (expires_at)
      WHERE consumed_at IS NULL
    `);
    await q.query(`DROP INDEX IF EXISTS verifications_expiry_idx`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS verifications_expiry_idx
      ON verifications (expires_at)
      WHERE consumed_at IS NULL AND is_deleted = false
    `);
    await q.query(`DROP INDEX IF EXISTS verifications_unconsumed_expiry_idx`);
    await q.query(`DROP INDEX IF EXISTS verifications_consumed_idx`);
    await q.query(`DROP INDEX IF EXISTS sessions_revoked_idx`);
  }
}
