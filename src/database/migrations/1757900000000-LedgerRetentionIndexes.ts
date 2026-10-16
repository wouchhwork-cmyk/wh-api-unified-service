import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the first retention the three ledgers have ever had.
 *
 * `inbound_events`, `outbound_events` and `sync_jobs` were never swept. They
 * are the largest tables in the schema and the only ones with a guaranteed
 * daily floor under their growth: the post-metrics refresh enqueues a job per
 * channel every day whether anything changed or not.
 *
 * Partial on the SETTLED statuses, which is both what the sweep asks for and
 * what keeps the index small — it holds only rows that are candidates for
 * removal, and shrinks as they are removed. Without them the nightly sweep
 * would be three sequential scans of the three biggest tables, which is the
 * exact trap migration 1757600000000 fixed for sessions and verifications.
 *
 * Dead letters are deliberately NOT in these predicates. A terminal failure is
 * a human's problem and the queue gauge alarms on it; sweeping it would erase
 * the evidence and the alarm together.
 *
 * EXPAND ONLY: additive, idempotent, and nothing reads them but the planner.
 */
export class LedgerRetentionIndexes1757900000000 implements MigrationInterface {
  name = 'LedgerRetentionIndexes1757900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS inbound_events_settled_idx
      ON inbound_events (created_at)
      WHERE status IN ('processed','skipped')
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS outbound_events_settled_idx
      ON outbound_events (created_at)
      WHERE status IN ('sent','cancelled')
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS sync_jobs_settled_idx
      ON sync_jobs (created_at)
      WHERE is_deleted = false AND status IN ('completed','cancelled')
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS sync_jobs_settled_idx`);
    await q.query(`DROP INDEX IF EXISTS outbound_events_settled_idx`);
    await q.query(`DROP INDEX IF EXISTS inbound_events_settled_idx`);
  }
}
