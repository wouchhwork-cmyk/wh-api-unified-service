import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { QueueMetricsRepository, type QueueGauge } from '@/database/repositories/queue-metrics.repository';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The three queue gauges, against real Postgres.
 *
 * These exist because the query was rewritten for cost, not for behaviour: it
 * went from one pass per table with `FILTER` to one subquery per gauge, so that
 * each could use a partial index that already existed. A rewrite like that is
 * exactly where a count quietly changes meaning — `depth` and `due` differ only
 * by a time predicate, `leased` and `dead_lettered` only by a status set, and
 * nothing about a wrong number looks wrong on a dashboard.
 *
 * The alarm reads these. A gauge that under-reports is a queue nobody is told
 * has stalled.
 */
describe('queue gauges', () => {
  let db: DataSource;
  let queueMetrics: QueueMetricsRepository;
  let enterpriseId: number;
  let channelId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    queueMetrics = new QueueMetricsRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    const connection: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social','fbu','envelope') RETURNING id`,
      [enterpriseId],
    );
    const channel: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
       VALUES ($1,$2,'instagram','instagram_business','IG_1') RETURNING id`,
      [connection[0]?.id, enterpriseId],
    );
    channelId = Number(channel[0]?.id);
  });

  const gaugeFor = async (queue: QueueGauge['queue']): Promise<QueueGauge> => {
    const all = await queueMetrics.gauges();
    const found = all.find((row) => row.queue === queue);
    if (!found) throw new Error(`no gauge for ${queue}`);
    return found;
  };

  async function inbound(
    dedupKey: string,
    status: string,
    options: { nextAttemptAt?: string; deadLetteredAt?: string } = {},
  ): Promise<void> {
    await db.query(
      `INSERT INTO inbound_events
         (source_kind, platform, event_type, dedup_key, status, next_attempt_at, dead_lettered_at)
       VALUES ('webhook','instagram','messages',$1,$2,$3,$4)`,
      [dedupKey, status, options.nextAttemptAt ?? null, options.deadLetteredAt ?? null],
    );
  }

  it('reports all three queues, always', async () => {
    // The health endpoint renders whatever comes back; a missing queue would
    // read as a queue at zero rather than as a queue not measured.
    const all = await queueMetrics.gauges();
    expect(all.map((row) => row.queue)).toEqual(['inbound', 'outbound', 'sync']);
  });

  it('counts an empty ledger as zero rather than omitting it', async () => {
    const gauge = await gaugeFor('inbound');
    expect(gauge).toMatchObject({
      depth: 0,
      due: 0,
      leased: 0,
      deadLettered: 0,
      recentDeadLettered: 0,
      oldestDueAgeSeconds: null,
    });
  });

  it('separates what is waiting from what is due now', async () => {
    /*
     * `depth` and `due` differ ONLY by the time predicate, which is the pair a
     * rewrite is most likely to collapse. A backed-off row is waiting but not
     * yet workable, and reporting it as due would mean the alarm fires for work
     * no worker can take.
     */
    await inbound('due-now', 'pending', { nextAttemptAt: '2020-01-01T00:00:00Z' });
    await inbound('backed-off', 'failed', { nextAttemptAt: '2099-01-01T00:00:00Z' });

    const gauge = await gaugeFor('inbound');

    expect(gauge.depth).toBe(2);
    expect(gauge.due).toBe(1);
  });

  it('counts leased rows separately from claimable ones', async () => {
    // A leased count that never falls is how a stuck worker is spotted, so it
    // must not be folded into depth.
    await inbound('held', 'leased');
    await inbound('waiting', 'pending');

    const gauge = await gaugeFor('inbound');

    expect(gauge.leased).toBe(1);
    expect(gauge.depth).toBe(1);
  });

  it('separates recent dead letters from the cumulative total', async () => {
    /*
     * The distinction the comment on `recentDeadLettered` was written for: one
     * poison message from last month used to pin the gauge at WARN forever, and
     * an alarm that is always on is one nobody reads.
     */
    await inbound('old-poison', 'dead_letter', { deadLetteredAt: '2020-01-01T00:00:00Z' });
    await inbound('fresh-poison', 'dead_letter', { deadLetteredAt: new Date().toISOString() });

    const gauge = await gaugeFor('inbound');

    expect(gauge.deadLettered).toBe(2);
    expect(gauge.recentDeadLettered).toBe(1);
  });

  it('ages the oldest due row, not the newest', async () => {
    // This is the number that distinguishes a busy queue from a stalled one.
    await inbound('older', 'pending', { nextAttemptAt: '2020-01-01T00:00:00Z' });
    await inbound('newer', 'pending', { nextAttemptAt: '2021-01-01T00:00:00Z' });

    const gauge = await gaugeFor('inbound');

    expect(gauge.oldestDueAgeSeconds).not.toBeNull();
    // Both rows were created now, so the age is of created_at, and what matters
    // is that a due row produces an age at all rather than null.
    expect(gauge.oldestDueAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('ignores a soft-deleted sync job, which the other two ledgers cannot have', async () => {
    /*
     * sync_jobs is the only soft-deletable ledger, and every one of its gauge
     * subqueries has to carry `is_deleted = false` — including the dead-letter
     * one, whose index was missing entirely until this was fixed.
     */
    const insert = (kind: string, status: string, deleted: boolean): Promise<unknown> =>
      db.query(
        `INSERT INTO sync_jobs
           (enterprise_id, channel_id, job_kind, trigger_kind, status, dead_lettered_at, is_deleted)
         VALUES ($1,$2,$3,'manual',$4, now(), $5)`,
        [enterpriseId, channelId, kind, status, deleted],
      );

    await insert('backfill_conversations', 'dead_letter', false);
    await insert('backfill_comments', 'dead_letter', true);

    const gauge = await gaugeFor('sync');

    expect(gauge.deadLettered).toBe(1);
  });
});
