import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { SyncJobKind, SyncJobStatus, SyncTriggerKind } from '@/shared/enums';
import { createTestDataSource, truncateTenantData } from './db.harness';

/**
 * Per-conversation resync, against real Postgres.
 *
 * The whole feature rests on one partial unique index over an EXPRESSION —
 * `COALESCE(target_platform_id, '')` — and expression indexes are exactly what a
 * mocked driver cannot check. Get it wrong in either direction and the failure
 * is silent: a bare three-column index lets unlimited channel-wide backfills
 * queue up, because a unique index treats every NULL as distinct; the old
 * two-column one makes two customers' resyncs collide, so the second person to
 * need repair never gets it.
 */
describe('conversation resync jobs', () => {
  let db: DataSource;
  let syncJobs: SyncJobRepository;
  let enterpriseId: number;
  let channelId: number;

  const ALICE = '1774658693722714';
  const BOB = '9988776655443322';

  beforeAll(async () => {
    db = await createTestDataSource();
    syncJobs = new SyncJobRepository(db);
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
       VALUES ($1,$2,'instagram','instagram_business','IG_1') RETURNING id`,
      [connection[0]?.id, enterpriseId],
    );
    channelId = Number(channel[0]?.id);
  });

  const resync = (target: string): Promise<boolean> =>
    syncJobs.enqueueIfAbsent({
      enterpriseId,
      channelId,
      jobKind: SyncJobKind.ResyncConversation,
      triggerKind: SyncTriggerKind.Manual,
      targetPlatformId: target,
    });

  it('queues one resync per person, and refuses a second for the same person', async () => {
    expect(await resync(ALICE)).toBe(true);
    // The button is clickable twice and the same repair must not run twice.
    expect(await resync(ALICE)).toBe(false);
  });

  it('lets two different people be repaired at the same time', async () => {
    // The old index was (channel_id, job_kind): Bob's repair would have been
    // silently swallowed while Alice's was in flight.
    expect(await resync(ALICE)).toBe(true);
    expect(await resync(BOB)).toBe(true);

    const rows: { count: number }[] = await db.query(
      `SELECT count(*)::int FROM sync_jobs WHERE job_kind = 'resync_conversation'`,
    );
    expect(rows[0]?.count).toBe(2);
  });

  it('still allows only one channel-wide walk of a kind', async () => {
    // The NULL target must not become an escape hatch from the original rule.
    const walk = (): Promise<boolean> =>
      syncJobs.enqueueIfAbsent({
        enterpriseId,
        channelId,
        jobKind: SyncJobKind.BackfillConversations,
        triggerKind: SyncTriggerKind.InitialConnect,
      });

    expect(await walk()).toBe(true);
    expect(await walk()).toBe(false);
  });

  it('does not let a targeted resync block the channel-wide walk', async () => {
    // Different kinds, and a repair for one customer must never stand in the way
    // of the account's own backfill.
    expect(await resync(ALICE)).toBe(true);
    expect(
      await syncJobs.enqueueIfAbsent({
        enterpriseId,
        channelId,
        jobKind: SyncJobKind.BackfillConversations,
        triggerKind: SyncTriggerKind.InitialConnect,
      }),
    ).toBe(true);
  });

  it('frees the slot once the repair has finished', async () => {
    await resync(ALICE);
    await db.query(`UPDATE sync_jobs SET status = $1 WHERE job_kind = 'resync_conversation'`, [
      SyncJobStatus.Completed,
    ]);

    // A second gap in the same thread, later, must be repairable.
    expect(await resync(ALICE)).toBe(true);
  });

  it('hands the target to the worker that claims it', async () => {
    await resync(ALICE);

    const claimed = await syncJobs.claimBatch('worker-a', 10, 120);
    const job = claimed.find((row) => row.jobKind === SyncJobKind.ResyncConversation);
    // Without this the walk has no user_id to pass and silently widens to the
    // whole account.
    expect(job?.targetPlatformId).toBe(ALICE);
  });

  it('leaves the target null on a channel-wide walk', async () => {
    await syncJobs.enqueueIfAbsent({
      enterpriseId,
      channelId,
      jobKind: SyncJobKind.BackfillConversations,
      triggerKind: SyncTriggerKind.InitialConnect,
    });

    const claimed = await syncJobs.claimBatch('worker-a', 10, 120);
    const job = claimed.find((row) => row.jobKind === SyncJobKind.BackfillConversations);
    expect(job?.targetPlatformId).toBeNull();
  });
});
