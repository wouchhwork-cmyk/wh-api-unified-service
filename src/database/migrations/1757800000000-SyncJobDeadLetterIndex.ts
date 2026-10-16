import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The queue gauge counts dead letters on all three ledgers the same way, and
 * only two of them had an index for it.
 *
 * `inbound_events` and `outbound_events` each carry a partial
 * `dead_letter_idx`; `sync_jobs` never did, so that one count fell back to a
 * sequential scan of the table — once a minute, forever, from a worker whose
 * whole job is to be cheap.
 *
 * `is_deleted = false` is part of the predicate because that is how the gauge
 * asks. sync_jobs is the only one of the three that is soft-deletable, and a
 * partial index serves only a query that repeats its predicate — the same trap
 * that made both retention sweeps scan in migration 1757600000000.
 *
 * EXPAND ONLY: additive, idempotent, and nothing depends on it but the planner.
 */
export class SyncJobDeadLetterIndex1757800000000 implements MigrationInterface {
  name = 'SyncJobDeadLetterIndex1757800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS sync_jobs_dead_letter_idx
      ON sync_jobs (dead_lettered_at DESC)
      WHERE is_deleted = false AND status = 'dead_letter'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS sync_jobs_dead_letter_idx`);
  }
}
