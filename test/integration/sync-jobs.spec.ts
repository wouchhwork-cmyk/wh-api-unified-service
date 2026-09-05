import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createTestDataSource, returningRows, truncateTenantData } from './db.harness';

/**
 * The backfill queue's mechanics, against real Postgres.
 *
 * Everything asserted here lives in SQL — the claim's FOR UPDATE SKIP LOCKED,
 * the lease fencing, the runnable predicate that has to surface a rate-limited
 * job once its park expires — so these cannot be tested against a mock.
 *
 * The reclaim test is the important one: 'running' is not a claimable status, so
 * without reclaim a backfill whose worker died never resumes at all.
 */
describe('sync job queue', () => {
  let db: DataSource;
  let enterpriseId: number;
  let channelId: number;

  const LEASE_SECONDS = 120;
  const CLAIMABLE = ['pending', 'failed', 'rate_limited'];

  beforeAll(async () => {
    db = await createTestDataSource();
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    const enterprise: { id: string }[] = await db.query(
      `INSERT INTO enterprises (name, slug, email) VALUES ('Acme','acme','a@acme.test') RETURNING id`,
    );
    enterpriseId = Number(enterprise[0]?.id);

    const connection: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social','fbu','envelope') RETURNING id`,
      [enterpriseId],
    );
    const channel: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
       VALUES ($1,$2,'facebook','page','PAGE_1') RETURNING id`,
      [connection[0]?.id, enterpriseId],
    );
    channelId = Number(channel[0]?.id);
  });

  const enqueue = async (jobKind: string, status = 'pending'): Promise<number> => {
    const rows: { id: string }[] = await db.query(
      `INSERT INTO sync_jobs (enterprise_id, channel_id, job_kind, trigger_kind, status, next_attempt_at)
       VALUES ($1,$2,$3,'initial_connect',$4,now()) RETURNING id`,
      [enterpriseId, channelId, jobKind, status],
    );
    return Number(rows[0]?.id);
  };

  const claim = async (leaseOwner: string, limit = 10): Promise<{ id: string }[]> =>
    returningRows<{ id: string }>(
      await db.query(
        `UPDATE sync_jobs
          SET status='running', lease_owner=$1,
              lease_expires_at = now() + ($2::int * interval '1 second'),
              attempt_count = attempt_count + 1,
              started_at = COALESCE(started_at, now())
        WHERE id IN (
          SELECT id FROM sync_jobs
           WHERE is_deleted = false AND status = ANY($3)
             AND COALESCE(next_attempt_at, rate_limited_until, created_at) <= now()
           ORDER BY COALESCE(next_attempt_at, rate_limited_until, created_at), id
           LIMIT $4 FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
        [leaseOwner, LEASE_SECONDS, CLAIMABLE, limit],
      ),
    );

  const statusOf = async (id: number): Promise<string> => {
    const rows: { status: string }[] = await db.query(
      `SELECT status FROM sync_jobs WHERE id = $1`,
      [id],
    );
    return rows[0]?.status ?? 'missing';
  };

  it('claims a pending job exactly once', async () => {
    await enqueue('backfill_comments');

    const first = await claim('worker-a');
    const second = await claim('worker-b');

    expect(first).toHaveLength(1);
    // Already 'running', which the claim predicate excludes.
    expect(second).toHaveLength(0);
  });

  it('does not claim a job whose rate-limit park is still in the future', async () => {
    const id = await enqueue('backfill_comments', 'rate_limited');
    await db.query(
      `UPDATE sync_jobs SET next_attempt_at = NULL, rate_limited_until = now() + interval '10 minutes' WHERE id = $1`,
      [id],
    );

    expect(await claim('worker-a')).toHaveLength(0);
  });

  it('claims a rate-limited job once its park has passed', async () => {
    const id = await enqueue('backfill_comments', 'rate_limited');
    await db.query(
      `UPDATE sync_jobs SET next_attempt_at = NULL, rate_limited_until = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );

    expect(await claim('worker-a')).toHaveLength(1);
  });

  it('returns a job to the pool when its lease has expired', async () => {
    const id = await enqueue('backfill_conversations');
    await claim('worker-a');
    // Simulate the worker dying: the lease lapses while the row stays 'running'.
    await db.query(
      `UPDATE sync_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );

    expect(await statusOf(id)).toBe('running');

    const reclaimed = returningRows<{ id: string }>(
      await db.query(
        `UPDATE sync_jobs
          SET status='pending', lease_owner=NULL, lease_expires_at=NULL, next_attempt_at=now()
        WHERE id IN (
          SELECT id FROM sync_jobs
           WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()
           ORDER BY lease_expires_at LIMIT 200 FOR UPDATE SKIP LOCKED
          ) RETURNING id`,
      ),
    );

    expect(reclaimed).toHaveLength(1);
    expect(await statusOf(id)).toBe('pending');
    expect(await claim('worker-b')).toHaveLength(1);
  });

  it('refuses a progress write from a worker that no longer holds the lease', async () => {
    const id = await enqueue('backfill_comments');
    await claim('worker-a');

    const saveProgress = async (owner: string): Promise<number> => {
      const result = await db.query(
        `UPDATE sync_jobs
            SET page_cursor = $3, synced_item_count = synced_item_count + 5
          WHERE id = $1 AND lease_owner = $2 AND status = 'running' RETURNING id`,
        [id, owner, 'cursor-1'],
      );
      return returningRows<{ id: string }>(result).length;
    };

    expect(await saveProgress('worker-a')).toBe(1);
    // The fence: a stale worker must not rewind the cursor of the one that owns
    // the job now.
    expect(await saveProgress('worker-b')).toBe(0);
  });

  it('keeps at most one live job per kind per channel', async () => {
    await enqueue('backfill_comments');

    const second = await db.query(
      `INSERT INTO sync_jobs (enterprise_id, channel_id, job_kind, trigger_kind, status, next_attempt_at)
       VALUES ($1,$2,'backfill_comments','reconnect','pending',now())
       ON CONFLICT (channel_id, job_kind, COALESCE(target_platform_id, ''))
         WHERE is_deleted = false AND status IN ('pending','running','paused','rate_limited')
       DO NOTHING
       RETURNING id`,
      [enterpriseId, channelId],
    );

    expect(second).toHaveLength(0);
  });

  it('reports queue depth and lag for every queue', async () => {
    await enqueue('backfill_comments');

    const gauges: {
      queue: string;
      depth: number;
      due: number;
      oldestDueAgeSeconds: number | null;
    }[] = await db.query(
      `WITH sync AS (
           SELECT 'sync' AS queue,
                  count(*) FILTER (WHERE is_deleted = false AND status IN ('pending','failed','rate_limited')) AS depth,
                  count(*) FILTER (WHERE is_deleted = false AND status IN ('pending','failed','rate_limited')
                                     AND COALESCE(next_attempt_at, rate_limited_until, created_at) <= now()) AS due,
                  min(created_at) FILTER (WHERE is_deleted = false AND status IN ('pending','failed','rate_limited')
                                     AND COALESCE(next_attempt_at, rate_limited_until, created_at) <= now()) AS oldest_due
             FROM sync_jobs
         )
         SELECT queue, depth::int AS "depth", due::int AS "due",
                CASE WHEN oldest_due IS NULL THEN NULL
                     ELSE floor(EXTRACT(EPOCH FROM (now() - oldest_due)))::int END AS "oldestDueAgeSeconds"
           FROM sync`,
    );

    const sync = gauges[0];
    expect(sync?.depth).toBe(1);
    expect(sync?.due).toBe(1);
    // Lag is measurable, which is the whole point of the gauge.
    expect(sync?.oldestDueAgeSeconds).not.toBeNull();
    expect(sync?.oldestDueAgeSeconds).toBeGreaterThanOrEqual(0);
  });
});
