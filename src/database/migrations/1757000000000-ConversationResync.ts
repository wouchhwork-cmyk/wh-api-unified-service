import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-conversation resync: a sync job can now be about ONE person.
 *
 * WHY A SECOND MIGRATION AT ALL, when the column is also in the V1 CREATE TABLE:
 * the two serve different databases. A database built from scratch gets the
 * column from V1, because `sync_jobs_live_uniq` in schema-objects.ts now
 * references it and would fail to create without it. A database that already
 * ran V1 before this change has neither, and this is the only thing that will
 * give them to it.
 *
 * So every statement here is idempotent — it is expected to run against both,
 * and to be a no-op on the first.
 *
 * EXPAND ONLY. The column is nullable with no default and no backfill, and the
 * index it replaces is swapped for a strictly WIDER one: every pair the old
 * index rejected, the new one still rejects, because a channel-wide job has
 * target_platform_id NULL and COALESCE maps all of those onto the same empty
 * string. Old code writing NULL keeps working unchanged, so this deploys safely
 * before the code that uses it.
 */
export class ConversationResync1757000000000 implements MigrationInterface {
  name = 'ConversationResync1757000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS target_platform_id VARCHAR(255)`);

    /*
     * COALESCE, not the bare column: a unique index treats every NULL as
     * distinct, so a three-column index over a nullable target would let an
     * unlimited number of channel-wide backfills queue up — the exact thing
     * this index exists to prevent.
     */
    await q.query(`DROP INDEX IF EXISTS sync_jobs_live_uniq`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_live_uniq
      ON sync_jobs (channel_id, job_kind, COALESCE(target_platform_id, ''))
      WHERE is_deleted = false
        AND status IN ('pending','running','paused','rate_limited')
    `);
  }

  /**
   * The narrower index cannot be restored while targeted jobs are live — two
   * customers' resyncs on one channel would collide on (channel_id, job_kind).
   * They are dropped first, which is the honest rollback: they are repair work,
   * re-requestable at any time, and nothing downstream depends on their rows.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM sync_jobs WHERE target_platform_id IS NOT NULL`);
    await q.query(`DROP INDEX IF EXISTS sync_jobs_live_uniq`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_live_uniq
      ON sync_jobs (channel_id, job_kind)
      WHERE is_deleted = false
        AND status IN ('pending','running','paused','rate_limited')
    `);
    await q.query(`ALTER TABLE sync_jobs DROP COLUMN IF EXISTS target_platform_id`);
  }
}
