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

  it('asks for a name when a live DM creates a nameless customer', async () => {
    /*
     * Instagram's messaging webhook carries a scoped id and nothing else, so a
     * customer whose first contact is a DM has no name and no way to get one —
     * the inbox showed "Unnamed customer" for somebody whose handle Meta hands
     * over for a single call. The resync is that call.
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
    const event = async (key: string): Promise<number> => {
      const rows: { id: string }[] = await db.query(
        `INSERT INTO inbound_events
           (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
         VALUES ($1,$2,'webhook','instagram','direct_message',$3,'{}') RETURNING id`,
        [enterpriseId, channelId, key],
      );
      return Number(rows[0]?.id);
    };

    await projector.project(enterpriseId, channelId, Platform.Instagram, await event('n1'), {
      sender: { id: ALICE },
      recipient: { id: 'IG_1' },
      timestamp: 1788679733587,
      message: { mid: 'NAMELESS_1', text: 'hello' },
    });

    const queued: { target_platform_id: string }[] = await db.query(
      `SELECT target_platform_id FROM sync_jobs WHERE job_kind = 'resync_conversation'`,
    );
    expect(queued.map((row) => row.target_platform_id)).toEqual([ALICE]);

    /*
     * And ONE request per person, not one per message: the second message from
     * the same customer must not queue anything, or a chatty conversation would
     * become a request per line.
     */
    await projector.project(enterpriseId, channelId, Platform.Instagram, await event('n2'), {
      sender: { id: ALICE },
      recipient: { id: 'IG_1' },
      timestamp: 1788679734587,
      message: { mid: 'NAMELESS_2', text: 'still here' },
    });

    const after: { count: number }[] = await db.query(
      `SELECT count(*)::int FROM sync_jobs WHERE job_kind = 'resync_conversation'`,
    );
    expect(after[0]?.count).toBe(1);
  });

  it('does not ask when the message already carries a name', async () => {
    // A backfilled or resynced event brings the name with it; asking again
    // would be a wasted call against a rate-limited API.
    const projector = new DirectMessageProjectorService(
      new CustomerRepository(db),
      new ConversationRepository(db),
      new MessageRepository(db),
      new MessageAttachmentRepository(db),
      syncJobs,
      new TransactionManager(db, silentLogger()),
      silentLogger(),
    );
    const rows: { id: string }[] = await db.query(
      `INSERT INTO inbound_events
         (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
       VALUES ($1,$2,'backfill','instagram','direct_message','named','{}') RETURNING id`,
      [enterpriseId, channelId],
    );

    await projector.project(enterpriseId, channelId, Platform.Instagram, Number(rows[0]?.id), {
      sender: { id: BOB, name: 'somebody', username: 'somebody' },
      recipient: { id: 'IG_1' },
      timestamp: 1788679733587,
      message: { mid: 'NAMED_1', text: 'hello' },
    });

    const count: { count: number }[] = await db.query(
      `SELECT count(*)::int FROM sync_jobs WHERE job_kind = 'resync_conversation'`,
    );
    expect(count[0]?.count).toBe(0);
  });

  it('threads a reply onto the message it answers', async () => {
    /*
     * Instagram lets somebody answer one specific message and names it in
     * reply_to.mid. parent_message_id existed and nothing ever filled it, so a
     * threaded reply was stored as a loose line and the inbox could not tell
     * which of several outbound messages it was aimed at.
     */
    const messages = new MessageRepository(db);
    const projector = new DirectMessageProjectorService(
      new CustomerRepository(db),
      new ConversationRepository(db),
      messages,
      new MessageAttachmentRepository(db),
      syncJobs,
      new TransactionManager(db, silentLogger()),
      silentLogger(),
    );
    const event = async (key: string): Promise<number> => {
      const rows: { id: string }[] = await db.query(
        `INSERT INTO inbound_events
           (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
         VALUES ($1,$2,'webhook','instagram','direct_message',$3,'{}') RETURNING id`,
        [enterpriseId, channelId, key],
      );
      return Number(rows[0]?.id);
    };

    await projector.project(enterpriseId, channelId, Platform.Instagram, await event('p1'), {
      sender: { id: ALICE },
      recipient: { id: 'IG_1' },
      timestamp: 1788682400000,
      message: { mid: 'PARENT_MID', text: 'tell me man' },
    });

    await projector.project(enterpriseId, channelId, Platform.Instagram, await event('p2'), {
      sender: { id: ALICE },
      recipient: { id: 'IG_1' },
      timestamp: 1788682501255,
      message: {
        mid: 'CHILD_MID',
        text: 'Reply',
        reply_to: { mid: 'PARENT_MID', is_self_reply: false },
      },
    });

    const rows: { body: string; parent_body: string | null; metadata: Record<string, unknown> }[] =
      await db.query(
        `SELECT m.body, p.body AS parent_body, m.metadata
           FROM messages m LEFT JOIN messages p ON p.id = m.parent_message_id
          WHERE m.platform_message_id = 'CHILD_MID'`,
      );
    expect(rows[0]?.parent_body).toBe('tell me man');
    expect(rows[0]?.metadata.replyIsSelfReply).toBe(false);
  });

  it('keeps the reply readable when the parent was never delivered', async () => {
    /*
     * A reply to a message whose webhook Meta dropped. The link cannot be made
     * — but the message itself must still arrive, and the platform id is kept
     * so the link can be made later without asking Meta again.
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
    const rows: { id: string }[] = await db.query(
      `INSERT INTO inbound_events
         (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
       VALUES ($1,$2,'webhook','instagram','direct_message','orphan-reply','{}') RETURNING id`,
      [enterpriseId, channelId],
    );

    const outcome = await projector.project(
      enterpriseId,
      channelId,
      Platform.Instagram,
      Number(rows[0]?.id),
      {
        sender: { id: BOB },
        recipient: { id: 'IG_1' },
        timestamp: 1788682694662,
        message: {
          mid: 'ORPHAN_CHILD',
          text: 'Hehee',
          reply_to: { mid: 'NEVER_ARRIVED', is_self_reply: true },
        },
      },
    );

    expect(outcome.projected).toBe(true);
    const stored: { parent_message_id: number | null; metadata: Record<string, unknown> }[] =
      await db.query(
        `SELECT parent_message_id, metadata FROM messages WHERE platform_message_id = 'ORPHAN_CHILD'`,
      );
    expect(stored[0]?.parent_message_id).toBeNull();
    expect(stored[0]?.metadata.replyToPlatformMessageId).toBe('NEVER_ARRIVED');
    expect(stored[0]?.metadata.replyIsSelfReply).toBe(true);
  });
});
