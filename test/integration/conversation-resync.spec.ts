import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { MessageAttachmentRepository } from '@/database/repositories/message-attachment.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { TransactionManager } from '@/database/transaction';
import { DirectMessageProjectorService } from '@/modules/inbox/direct-message-projector.service';
import { Platform, SyncJobKind, SyncJobStatus, SyncTriggerKind } from '@/shared/enums';
import { createTestDataSource, truncateTenantData } from './db.harness';

/** The projector logs; nothing here asserts on it. */
function silentLogger(): never {
  return {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  } as never;
}

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

  it('stores a handle that arrives with a recovered message', async () => {
    /*
     * The ordering bug this pins. Meta's participants edge returns
     * `username` and the backfill used to link it itself — but only for a
     * customer that ALREADY EXISTED, and on a resync the customer is created
     * afterwards, by the projector reading the events the backfill emitted. So
     * on first contact the handle was resolved, used for the display name, and
     * then thrown away, and the person could not be found by the name they are
     * actually known by.
     */
    const projector = new DirectMessageProjectorService(
      new CustomerRepository(db),
      new ConversationRepository(db),
      new MessageRepository(db),
      new MessageAttachmentRepository(db),
      syncJobs,
      new TransactionManager(db, silentLogger()),
      silentLogger(),
    );

    const event: { id: string }[] = await db.query(
      `INSERT INTO inbound_events
         (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
       VALUES ($1,$2,'backfill','instagram','direct_message','instagram:direct_message:h1','{}')
       RETURNING id`,
      [enterpriseId, channelId],
    );

    const outcome = await projector.project(
      enterpriseId,
      channelId,
      Platform.Instagram,
      Number(event[0]?.id),
      {
        sender: { id: ALICE, name: 'lokhandesmasalahouse', username: 'lokhandesmasalahouse' },
        recipient: { id: 'IG_1' },
        timestamp: 1788679733587,
        message: { mid: 'RECOVERED_1', text: 'Hii' },
      },
    );
    expect(outcome.projected).toBe(true);

    const identifiers: { identifier_kind: string; identifier_value: string }[] = await db.query(
      `SELECT identifier_kind, identifier_value FROM customer_identifiers
        WHERE enterprise_id = $1 ORDER BY identifier_kind`,
      [enterpriseId],
    );

    // BOTH: the scoped id the platform addresses them by, and the handle a
    // colleague would actually search for.
    expect(identifiers.map((row) => row.identifier_kind)).toEqual([
      'instagram_user_id',
      'instagram_username',
    ]);
    expect(identifiers[1]?.identifier_value).toBe('lokhandesmasalahouse');
  });

  it('stores no handle when the platform did not give one', async () => {
    // A live webhook carries neither name nor handle, and inventing one from
    // the numeric id would be worse than having none.
    const projector = new DirectMessageProjectorService(
      new CustomerRepository(db),
      new ConversationRepository(db),
      new MessageRepository(db),
      new MessageAttachmentRepository(db),
      syncJobs,
      new TransactionManager(db, silentLogger()),
      silentLogger(),
    );

    const event: { id: string }[] = await db.query(
      `INSERT INTO inbound_events
         (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
       VALUES ($1,$2,'webhook','instagram','direct_message','instagram:direct_message:h2','{}')
       RETURNING id`,
      [enterpriseId, channelId],
    );

    await projector.project(enterpriseId, channelId, Platform.Instagram, Number(event[0]?.id), {
      sender: { id: BOB },
      recipient: { id: 'IG_1' },
      timestamp: 1788679733587,
      message: { mid: 'LIVE_1', text: 'hello' },
    });

    const kinds: { identifier_kind: string }[] = await db.query(
      `SELECT identifier_kind FROM customer_identifiers
        WHERE enterprise_id = $1 AND identifier_value = $2`,
      [enterpriseId, BOB],
    );
    expect(kinds.map((row) => row.identifier_kind)).toEqual(['instagram_user_id']);
  });
});
