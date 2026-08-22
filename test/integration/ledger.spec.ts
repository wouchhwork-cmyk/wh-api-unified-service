import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createTestDataSource, returningRows, truncateTenantData } from './db.harness';

/**
 * The transport ledger's mechanics, against real Postgres.
 *
 * These behaviours are all implemented in SQL — FOR UPDATE SKIP LOCKED, partial
 * index conflict targets, parameter casts — so a mock would prove nothing about
 * them. Two of the assertions here exist because the real database rejected the
 * first version of the query.
 */
describe('transport ledger', () => {
  let db: DataSource;
  let enterpriseId: number;
  let channelId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    const enterprise = (await db.query(
      `INSERT INTO enterprises (name, slug, email) VALUES ('Acme','acme','a@acme.test') RETURNING id`,
    )) as { id: string }[];
    enterpriseId = Number(enterprise[0]?.id);

    const connection = (await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social','fbu','envelope') RETURNING id`,
      [enterpriseId],
    )) as { id: string }[];
    const channel = (await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
       VALUES ($1,$2,'facebook','page','PAGE_1') RETURNING id`,
      [connection[0]?.id, enterpriseId],
    )) as { id: string }[];
    channelId = Number(channel[0]?.id);
  });

  const insertEvent = async (dedupKey: string, priority = 30): Promise<void> => {
    await db.query(
      `INSERT INTO inbound_events
         (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key,
          payload, priority, status, next_attempt_at)
       VALUES ($1,$2,'channel','facebook','comment',$3,'{}',$4,'pending',now())`,
      [enterpriseId, channelId, dedupKey, priority],
    );
  };

  /** The exact claim statement the repository issues. */
  const claim = async (owner: string, limit: number): Promise<number[]> => {
    const result: unknown = await db.query(
      `UPDATE inbound_events
          SET status = 'processing', lease_owner = $1,
              lease_expires_at = now() + interval '120 seconds',
              attempt_count = attempt_count + 1
        WHERE id IN (
          SELECT id FROM inbound_events
           WHERE status IN ('pending','failed')
             AND COALESCE(next_attempt_at, created_at) <= now()
           ORDER BY priority, COALESCE(next_attempt_at, created_at), id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, priority`,
      [owner, limit],
    );
    return returningRows<{ id: number; priority: number }>(result).map((row) => row.id);
  };

  it('claims each row exactly once across concurrent workers', async () => {
    for (let n = 0; n < 10; n += 1) await insertEvent(`meta:comment:c${n}`);

    // Two workers claiming at the same moment. SKIP LOCKED means neither waits
    // and neither takes the other's rows.
    const [first, second] = await Promise.all([claim('worker-a', 5), claim('worker-b', 5)]);

    const overlap = first.filter((id) => second.includes(id));
    expect(overlap).toEqual([]);
    expect(new Set([...first, ...second]).size).toBe(10);
  });

  it('selects higher-priority work first when the batch cannot hold everything', async () => {
    await insertEvent('meta:comment:low', 40);
    await insertEvent('meta:comment:urgent', 10);
    await insertEvent('meta:comment:normal', 30);

    // A batch of one must take the urgent row, not the oldest.
    const claimed = await claim('worker-a', 1);
    const rows = (await db.query(`SELECT priority FROM inbound_events WHERE id = $1`, [
      claimed[0],
    ])) as { priority: number }[];
    expect(rows[0]?.priority).toBe(10);
  });

  it('rejects a redelivered event, and a duplicate is not an error to the caller', async () => {
    const insertIgnoring = async (): Promise<boolean> => {
      const result: unknown = await db.query(
        `INSERT INTO inbound_events
           (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload, status)
         VALUES ($1,$2,'channel','facebook','comment','meta:comment:same','{}','pending')
         ON CONFLICT (COALESCE(enterprise_id, 0), dedup_key) DO NOTHING
         RETURNING id`,
        [enterpriseId, channelId],
      );
      return returningRows(result).length > 0;
    };

    expect(await insertIgnoring()).toBe(true);
    // The second attempt inserts nothing and raises nothing: a duplicate is a
    // success, so Meta stops retrying.
    expect(await insertIgnoring()).toBe(false);
  });

  it('writes delivery state back to the message keyed on the ledger row', async () => {
    // The relay knows which EVENT it sent, not which message — so the write-back
    // joins on outbound_event_id. This test exists because the first version of
    // that statement failed with "inconsistent types deduced for parameter $3",
    // which left a delivered reply showing as pending forever.
    const customer = (await db.query(
      `INSERT INTO customers (enterprise_id, first_source) VALUES ($1,'manual') RETURNING id`,
      [enterpriseId],
    )) as { id: string }[];
    const conversation = (await db.query(
      `INSERT INTO conversations
         (enterprise_id, channel_id, customer_id, platform, conversation_kind, platform_thread_id)
       VALUES ($1,$2,$3,'facebook','comment_thread','comment:C1') RETURNING id`,
      [enterpriseId, channelId, customer[0]?.id],
    )) as { id: string }[];
    const event = (await db.query(
      `INSERT INTO outbound_events
         (enterprise_id, channel_id, destination_kind, platform, event_type, dedup_key, payload, status)
       VALUES ($1,$2,'channel','facebook','comment_reply','facebook:comment_reply:messages:1','{}','sending')
       RETURNING id`,
      [enterpriseId, channelId],
    )) as { id: string }[];
    await db.query(
      `INSERT INTO messages
         (enterprise_id, conversation_id, direction, outbound_event_id, message_kind, body, status)
       VALUES ($1,$2,'outbound',$3,'text','hello','pending')`,
      [enterpriseId, conversation[0]?.id, event[0]?.id],
    );

    await db.query(
      `UPDATE messages
          SET platform_message_id = COALESCE($2::varchar, platform_message_id),
              status = $3::varchar,
              platform_sent_at = CASE WHEN $3::varchar = 'sent' THEN now() ELSE platform_sent_at END
        WHERE outbound_event_id = $1`,
      [event[0]?.id, 'PLATFORM_1', 'sent'],
    );

    const rows = (await db.query(
      `SELECT status, platform_message_id, (platform_sent_at IS NOT NULL) AS stamped
         FROM messages WHERE direction = 'outbound'`,
    )) as { status: string; platform_message_id: string; stamped: boolean }[];

    expect(rows[0]?.status).toBe('sent');
    expect(rows[0]?.platform_message_id).toBe('PLATFORM_1');
    expect(rows[0]?.stamped).toBe(true);
  });

  it('keeps one live sync job per kind per channel, and lets a finished one repeat', async () => {
    const enqueue = async (): Promise<boolean> => {
      const result: unknown = await db.query(
        `INSERT INTO sync_jobs (enterprise_id, channel_id, job_kind, trigger_kind, status)
         VALUES ($1,$2,'backfill_posts','initial_connect','pending')
         ON CONFLICT (channel_id, job_kind)
           WHERE is_deleted = false AND status IN ('pending','running','paused','rate_limited')
         DO NOTHING
         RETURNING id`,
        [enterpriseId, channelId],
      );
      return returningRows(result).length > 0;
    };

    expect(await enqueue()).toBe(true);
    // Reconnecting an already-syncing account must not start a second walk.
    expect(await enqueue()).toBe(false);

    // Once it completes it leaves the live slot, so a scheduled refresh can run.
    await db.query(`UPDATE sync_jobs SET status = 'completed', completed_at = now()`);
    expect(await enqueue()).toBe(true);
  });
});
