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
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

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

  async function seedEnterpriseWithChannel(): Promise<{
    enterpriseId: number;
    channelId: number;
  }> {
    const other = await seedEnterprise(db, 'Rival', 'rival');
    const connection: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social','fbu2','envelope') RETURNING id`,
      [other],
    );
    const channel: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
       VALUES ($1,$2,'instagram','instagram_business','IG_2') RETURNING id`,
      [connection[0]?.id, other],
    );
    return { enterpriseId: other, channelId: Number(channel[0]?.id) };
  }

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

  it('links a reply that was stored before the message it answers', async () => {
    /*
     * The order a recovery actually arrives in. Graph returns a thread NEWEST
     * FIRST, so every reply in it is projected before its parent — resolving
     * only downwards left each one saying "a message we never received" about a
     * message sitting two rows below it.
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
         VALUES ($1,$2,'backfill','instagram','direct_message',$3,'{}') RETURNING id`,
        [enterpriseId, channelId, key],
      );
      return Number(rows[0]?.id);
    };

    // The CHILD first, exactly as a newest-first page delivers it.
    await projector.project(enterpriseId, channelId, Platform.Instagram, await event('c'), {
      sender: { id: ALICE },
      recipient: { id: 'IG_1' },
      timestamp: 1788682501255,
      message: {
        mid: 'CHILD_FIRST',
        text: 'Reply',
        reply_to: { mid: 'PARENT_LATER', is_self_reply: false },
      },
    });

    const before: { parent_message_id: number | null }[] = await db.query(
      `SELECT parent_message_id FROM messages WHERE platform_message_id = 'CHILD_FIRST'`,
    );
    expect(before[0]?.parent_message_id).toBeNull();

    // Then the parent, which must claim the reply already waiting on it.
    await projector.project(enterpriseId, channelId, Platform.Instagram, await event('p'), {
      sender: { id: ALICE },
      recipient: { id: 'IG_1' },
      timestamp: 1788682400000,
      message: { mid: 'PARENT_LATER', text: 'tell me man' },
    });

    const after: { body: string | null }[] = await db.query(
      `SELECT p.body FROM messages m JOIN messages p ON p.id = m.parent_message_id
        WHERE m.platform_message_id = 'CHILD_FIRST'`,
    );
    expect(after[0]?.body).toBe('tell me man');
  });

  it('does not adopt a reply belonging to another business', async () => {
    // The adoption is a broad UPDATE keyed on a platform id, and platform ids
    // are not ours to assume unique across tenants.
    const projector = new DirectMessageProjectorService(
      new CustomerRepository(db),
      new ConversationRepository(db),
      new MessageRepository(db),
      new MessageAttachmentRepository(db),
      syncJobs,
      new TransactionManager(db, silentLogger()),
      silentLogger(),
    );
    const otherEnterprise = await seedEnterpriseWithChannel();

    const stranger: { id: string }[] = await db.query(
      `INSERT INTO inbound_events
         (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
       VALUES ($1,$2,'webhook','instagram','direct_message','x','{}') RETURNING id`,
      [otherEnterprise.enterpriseId, otherEnterprise.channelId],
    );
    await projector.project(
      otherEnterprise.enterpriseId,
      otherEnterprise.channelId,
      Platform.Instagram,
      Number(stranger[0]?.id),
      {
        sender: { id: ALICE },
        recipient: { id: 'IG_2' },
        timestamp: 1788682501255,
        message: { mid: 'SHARED_MID_CHILD', text: 'theirs', reply_to: { mid: 'SHARED_MID' } },
      },
    );

    const mine: { id: string }[] = await db.query(
      `INSERT INTO inbound_events
         (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
       VALUES ($1,$2,'webhook','instagram','direct_message','y','{}') RETURNING id`,
      [enterpriseId, channelId],
    );
    await projector.project(enterpriseId, channelId, Platform.Instagram, Number(mine[0]?.id), {
      sender: { id: ALICE },
      recipient: { id: 'IG_1' },
      timestamp: 1788682400000,
      message: { mid: 'SHARED_MID', text: 'mine' },
    });

    const theirs: { parent_message_id: number | null }[] = await db.query(
      `SELECT parent_message_id FROM messages WHERE platform_message_id = 'SHARED_MID_CHILD'`,
    );
    expect(theirs[0]?.parent_message_id).toBeNull();
  });

  it('stores a reply we sent from the Instagram app, and links what answered it', async () => {
    /*
     * The recovery used to discard anything from our own account as "an echo of
     * our own outbound message". True for a LIVE echo — the reply flow already
     * wrote that row — but a reply typed in the Instagram app was never
     * recorded here at all, so discarding it left the inbox showing one side of
     * the conversation and made every "replying to you" unresolvable.
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
         VALUES ($1,$2,'backfill','instagram','direct_message',$3,'{}') RETURNING id`,
        [enterpriseId, channelId, key],
      );
      return Number(rows[0]?.id);
    };

    // The customer's reply arrives first, answering something we sent.
    await projector.project(enterpriseId, channelId, Platform.Instagram, await event('r'), {
      sender: { id: ALICE },
      recipient: { id: 'IG_1' },
      timestamp: 1788682501255,
      message: {
        mid: 'THEIR_REPLY',
        text: 'Reply',
        reply_to: { mid: 'OUR_MID', is_self_reply: false },
      },
    });

    // Then our own message, recovered from the platform.
    const outcome = await projector.project(
      enterpriseId,
      channelId,
      Platform.Instagram,
      await event('o'),
      {
        sender: { id: 'IG_1' },
        recipient: { id: ALICE },
        recovered: true,
        timestamp: 1788682400000,
        message: { mid: 'OUR_MID', text: 'tell me man', is_echo: true },
      },
    );
    expect(outcome.projected).toBe(true);

    const ours: { direction: string; sent_by_employee_id: number | null; status: string }[] =
      await db.query(
        `SELECT direction, sent_by_employee_id, status FROM messages
          WHERE platform_message_id = 'OUR_MID'`,
      );
    expect(ours[0]?.direction).toBe('outbound');
    // Nobody typed it HERE, and naming a colleague would be an invention.
    expect(ours[0]?.sent_by_employee_id).toBeNull();

    // And the reply that was waiting on it now points at it.
    const linked: { body: string | null }[] = await db.query(
      `SELECT p.body FROM messages m JOIN messages p ON p.id = m.parent_message_id
        WHERE m.platform_message_id = 'THEIR_REPLY'`,
    );
    expect(linked[0]?.body).toBe('tell me man');
  });

  it('ignores an echo of a message we already hold', async () => {
    /*
     * The rule is POSSESSION, not liveness. The first version of this asked
     * whether the event was live, and was wrong in the case that matters: a
     * reply typed in the Instagram app is echoed live, the portal never sent
     * it, and discarding it left the thread reading as a monologue.
     *
     * Here the portal did send it and the relay stamped the platform's id, so
     * the echo must change nothing.
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

    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
       VALUES ($1,'echo tester','instagram_dm',$2) RETURNING id`,
      [enterpriseId, channelId],
    );
    const conversation: { id: string }[] = await db.query(
      `INSERT INTO conversations
         (enterprise_id, channel_id, customer_id, platform, conversation_kind,
          platform_thread_id, status)
       VALUES ($1,$2,$3,'instagram','direct_message',$4,'open') RETURNING id`,
      [enterpriseId, channelId, customer[0]?.id, `dm:${ALICE}`],
    );
    await db.query(
      `INSERT INTO messages
         (enterprise_id, conversation_id, direction, platform_message_id, message_kind, body,
          status, is_read)
       VALUES ($1,$2,'outbound','ALREADY_HELD','text','sent from the portal','sent',true)`,
      [enterpriseId, conversation[0]?.id],
    );

    const rows: { id: string }[] = await db.query(
      `INSERT INTO inbound_events
         (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
       VALUES ($1,$2,'webhook','instagram','direct_message','live-echo','{}') RETURNING id`,
      [enterpriseId, channelId],
    );
    const outcome = await projector.project(
      enterpriseId,
      channelId,
      Platform.Instagram,
      Number(rows[0]?.id),
      {
        sender: { id: 'IG_1' },
        recipient: { id: ALICE },
        timestamp: 1788682400000,
        message: { mid: 'ALREADY_HELD', text: 'sent from the portal', is_echo: true },
      },
    );

    expect(outcome.projected).toBe(false);
    const count: { count: number }[] = await db.query(
      `SELECT count(*)::int FROM messages WHERE platform_message_id = 'ALREADY_HELD'`,
    );
    expect(count[0]?.count).toBe(1);
  });

  it('stamps a send the echo beat, rather than storing it twice', async () => {
    /*
     * Meta's echo can outrun the relay recording the platform id. The pending
     * row and the echo share only their body — the echo carries no idempotency
     * key and the row carries no platform id — so that is what matches them.
     * Getting this wrong means two copies of every reply the portal sends.
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

    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
       VALUES ($1,'race tester','instagram_dm',$2) RETURNING id`,
      [enterpriseId, channelId],
    );
    const conversation: { id: string }[] = await db.query(
      `INSERT INTO conversations
         (enterprise_id, channel_id, customer_id, platform, conversation_kind,
          platform_thread_id, status)
       VALUES ($1,$2,$3,'instagram','direct_message',$4,'open') RETURNING id`,
      [enterpriseId, channelId, customer[0]?.id, `dm:${BOB}`],
    );
    await db.query(
      `INSERT INTO messages
         (enterprise_id, conversation_id, direction, message_kind, body, status, is_read)
       VALUES ($1,$2,'outbound','text','still in flight','sending',true)`,
      [enterpriseId, conversation[0]?.id],
    );

    const rows: { id: string }[] = await db.query(
      `INSERT INTO inbound_events
         (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
       VALUES ($1,$2,'webhook','instagram','direct_message','race-echo','{}') RETURNING id`,
      [enterpriseId, channelId],
    );
    await projector.project(enterpriseId, channelId, Platform.Instagram, Number(rows[0]?.id), {
      sender: { id: 'IG_1' },
      recipient: { id: BOB },
      timestamp: 1788682400000,
      message: { mid: 'RACED_MID', text: 'still in flight', is_echo: true },
    });

    const stored: { count: number; platform_message_id: string | null }[] = await db.query(
      `SELECT count(*)::int AS count, min(platform_message_id) AS platform_message_id
         FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`,
      [conversation[0]?.id],
    );
    // ONE row, and it gained the id it was waiting for.
    expect(stored[0]?.count).toBe(1);
    expect(stored[0]?.platform_message_id).toBe('RACED_MID');
  });

  describe('events about a message rather than being one', () => {
    let projector: DirectMessageProjectorService;
    let messages: MessageRepository;

    beforeEach(async () => {
      messages = new MessageRepository(db);
      projector = new DirectMessageProjectorService(
        new CustomerRepository(db),
        new ConversationRepository(db),
        messages,
        new MessageAttachmentRepository(db),
        syncJobs,
        new TransactionManager(db, silentLogger()),
        silentLogger(),
      );
    });

    const event = async (key: string): Promise<number> => {
      const rows: { id: string }[] = await db.query(
        `INSERT INTO inbound_events
           (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
         VALUES ($1,$2,'webhook','instagram','direct_message',$3,'{}') RETURNING id`,
        [enterpriseId, channelId, key],
      );
      return Number(rows[0]?.id);
    };

    const seedMessage = async (mid: string, key: string): Promise<void> => {
      await projector.project(enterpriseId, channelId, Platform.Instagram, await event(key), {
        sender: { id: ALICE },
        recipient: { id: 'IG_1' },
        timestamp: 1788682400000,
        message: { mid, text: 'the original' },
      });
    };

    it('records a reaction on the message, not as a message', async () => {
      await seedMessage('REACTED_MID', 'a');

      const outcome = await projector.project(
        enterpriseId,
        channelId,
        Platform.Instagram,
        await event('b'),
        {
          sender: { id: ALICE },
          recipient: { id: 'IG_1' },
          timestamp: 1788682500000,
          reaction: {
            mid: 'REACTED_MID',
            action: 'react',
            reaction: 'love',
            emoji: '\u2764\ufe0f',
          },
        },
      );
      // Not projected: a thread showing the emoji as its own line would
      // misrepresent the conversation.
      expect(outcome.projected).toBe(false);

      const rows: { metadata: Record<string, unknown>; count: number }[] = await db.query(
        `SELECT metadata, (SELECT count(*)::int FROM messages) AS count
           FROM messages WHERE platform_message_id = 'REACTED_MID'`,
      );
      expect(rows[0]?.count).toBe(1);
      expect(rows[0]?.metadata.reaction).toMatchObject({ name: 'love' });
    });

    it('removes a reaction on unreact', async () => {
      await seedMessage('UNREACT_MID', 'c');
      const react = { mid: 'UNREACT_MID', action: 'react' as const, reaction: 'love' };
      await projector.project(enterpriseId, channelId, Platform.Instagram, await event('d'), {
        sender: { id: ALICE },
        recipient: { id: 'IG_1' },
        timestamp: 1788682500000,
        reaction: react,
      });
      await projector.project(enterpriseId, channelId, Platform.Instagram, await event('e'), {
        sender: { id: ALICE },
        recipient: { id: 'IG_1' },
        timestamp: 1788682600000,
        reaction: { mid: 'UNREACT_MID', action: 'unreact' },
      });

      const rows: { metadata: Record<string, unknown> }[] = await db.query(
        `SELECT metadata FROM messages WHERE platform_message_id = 'UNREACT_MID'`,
      );
      expect(rows[0]?.metadata.reaction).toBeUndefined();
    });

    it('KEEPS an unsent message, and marks what happened', async () => {
      /*
       * The point of the whole feature. Erasing it would change a conversation
       * the business is accountable for underneath whoever handled it — someone
       * can unsend an insult or a commitment and the record would silently stop
       * matching what was said.
       */
      await seedMessage('UNSENT_MID', 'f');

      await projector.project(enterpriseId, channelId, Platform.Instagram, await event('g'), {
        sender: { id: ALICE },
        recipient: { id: 'IG_1' },
        timestamp: 1788682700000,
        message: { mid: 'UNSENT_MID', is_deleted: true },
      });

      const rows: { body: string | null; platform_deleted_at: Date | null; is_deleted: boolean }[] =
        await db.query(
          `SELECT body, platform_deleted_at, is_deleted FROM messages
            WHERE platform_message_id = 'UNSENT_MID'`,
        );
      expect(rows[0]?.body).toBe('the original');
      expect(rows[0]?.platform_deleted_at).not.toBeNull();
      // Our own soft-delete means "removed from this product" and must not move.
      expect(rows[0]?.is_deleted).toBe(false);
    });

    it('does not store an unsend as a new empty message', async () => {
      // It arrives as a `message` with a mid, so without its own branch it
      // would fall through and be projected as a blank line.
      await projector.project(enterpriseId, channelId, Platform.Instagram, await event('h'), {
        sender: { id: ALICE },
        recipient: { id: 'IG_1' },
        timestamp: 1788682700000,
        message: { mid: 'GHOST_MID', is_deleted: true },
      });

      const rows: { count: number }[] = await db.query(
        `SELECT count(*)::int FROM messages WHERE platform_message_id = 'GHOST_MID'`,
      );
      expect(rows[0]?.count).toBe(0);
    });

    it('marks a read receipt against every earlier message we sent', async () => {
      /*
       * Instagram names ONE message. A receipt for a later one means the
       * earlier ones were seen too, and marking only the named message would
       * show message five read while one to four are not.
       */
      const customer: { id: string }[] = await db.query(
        `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
         VALUES ($1,'seen tester','instagram_dm',$2) RETURNING id`,
        [enterpriseId, channelId],
      );
      const conversation: { id: string }[] = await db.query(
        `INSERT INTO conversations
           (enterprise_id, channel_id, customer_id, platform, conversation_kind,
            platform_thread_id, status)
         VALUES ($1,$2,$3,'instagram','direct_message','dm:seen','open') RETURNING id`,
        [enterpriseId, channelId, customer[0]?.id],
      );

      await db.query(
        `INSERT INTO messages
           (enterprise_id, conversation_id, direction, platform_message_id, message_kind, body,
            platform_sent_at, status, is_read)
         VALUES ($1,$2,'outbound','OUT_1','text','first', now() - interval '2 min','delivered',true),
                ($1,$2,'outbound','OUT_2','text','second', now() - interval '1 min','delivered',true),
                ($1,$2,'inbound','IN_1','text','theirs', now() - interval '90 sec','delivered',false)`,
        [enterpriseId, conversation[0]?.id],
      );

      const marked = await messages.markSeenByCustomer(enterpriseId, 'OUT_2', new Date());
      // Both of ours, and NOT the customer's own message — a read receipt is
      // about what they read, not what they wrote.
      expect(marked).toBe(2);

      const theirs: { metadata: Record<string, unknown> }[] = await db.query(
        `SELECT metadata FROM messages WHERE platform_message_id = 'IN_1'`,
      );
      expect(theirs[0]?.metadata.seenAt).toBeUndefined();
    });
  });

  it('refuses an echo that names the business on both sides', async () => {
    /*
     * The backfill used to stamp the business as the recipient of every
     * message, its own included — so a recovered reply of ours opened a thread
     * keyed on our own account id, with a nameless customer that was us. Four
     * real replies went there before it was noticed.
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
       VALUES ($1,$2,'backfill','instagram','direct_message','self-addressed','{}') RETURNING id`,
      [enterpriseId, channelId],
    );

    const outcome = await projector.project(
      enterpriseId,
      channelId,
      Platform.Instagram,
      Number(rows[0]?.id),
      {
        sender: { id: 'IG_1' },
        recipient: { id: 'IG_1' },
        recovered: true,
        timestamp: 1788682400000,
        message: { mid: 'SELF_ADDRESSED', text: 'ours', is_echo: true },
      },
    );

    expect(outcome.projected).toBe(false);
    const threads: { count: number }[] = await db.query(
      `SELECT count(*)::int FROM conversations WHERE platform_thread_id = 'dm:IG_1'`,
    );
    expect(threads[0]?.count).toBe(0);
  });

  it('will not offer to reply to a message the platform no longer has', async () => {
    /*
     * Meta refuses reply_to against an unsent message with a bare "Invalid
     * parameter", which the relay can only dead-letter — so the agent's reply
     * is lost after they typed it. Seen exactly that way: the customer unsent a
     * message at 17:03:35 and a reply to it was rejected at 17:09:41.
     *
     * The row is still kept and still shown; it just cannot be threaded onto.
     */
    const messages = new MessageRepository(db);
    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
       VALUES ($1,'unsend tester','instagram_dm',$2) RETURNING id`,
      [enterpriseId, channelId],
    );
    const conversation: { id: string }[] = await db.query(
      `INSERT INTO conversations
         (enterprise_id, channel_id, customer_id, platform, conversation_kind,
          platform_thread_id, status)
       VALUES ($1,$2,$3,'instagram','direct_message','dm:unsent','open') RETURNING id`,
      [enterpriseId, channelId, customer[0]?.id],
    );
    const stored: { ref_id: string }[] = await db.query(
      `INSERT INTO messages
         (enterprise_id, conversation_id, direction, platform_message_id, message_kind, body,
          status, is_read, platform_deleted_at)
       VALUES ($1,$2,'inbound','UNSENT_TARGET','text','they took it back','delivered',false, now())
       RETURNING ref_id`,
      [enterpriseId, conversation[0]?.id],
    );

    const target = await messages.findReplyTarget(
      enterpriseId,
      Number(conversation[0]?.id),
      stored[0]?.ref_id as string,
    );
    // Found — the row is kept — but flagged as unthreadable.
    expect(target?.deletedOnPlatform).toBe(true);

    const row = await messages.listThread(enterpriseId, Number(conversation[0]?.id), 10, null);
    expect(row[0]?.canBeRepliedTo).toBe(false);
  });

  it('marks a recovered message whose content the platform will not return', async () => {
    /*
     * Meta exposes a shared post, story or reel ONLY on the live webhook. Every
     * read path returns it empty — the conversations edge, and the message node
     * asked directly for attachments, shares, story and sticker. So a dropped
     * delivery leaves a message with an id, a time, and no content, for good.
     *
     * The thread showed "(no text)", which reads as the customer sending an
     * empty message — the one thing that did not happen.
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
         VALUES ($1,$2,'backfill','instagram','direct_message',$3,'{}') RETURNING id`,
        [enterpriseId, channelId, key],
      );
      return Number(rows[0]?.id);
    };

    await projector.project(enterpriseId, channelId, Platform.Instagram, await event('u1'), {
      sender: { id: ALICE },
      recipient: { id: 'IG_1' },
      recovered: true,
      timestamp: 1788696752960,
      message: { mid: 'EMPTY_RECOVERED', text: '' },
    });

    const marked: { metadata: Record<string, unknown> }[] = await db.query(
      `SELECT metadata FROM messages WHERE platform_message_id = 'EMPTY_RECOVERED'`,
    );
    expect(marked[0]?.metadata.contentUnavailable).toBe(true);
  });

  it('does not mark a live message that simply carries no text', async () => {
    // A live delivery with an attachment and no caption is complete, not
    // damaged — claiming the platform withheld something would be a lie.
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
       VALUES ($1,$2,'webhook','instagram','direct_message','live-empty','{}') RETURNING id`,
      [enterpriseId, channelId],
    );
    await projector.project(enterpriseId, channelId, Platform.Instagram, Number(rows[0]?.id), {
      sender: { id: BOB },
      recipient: { id: 'IG_1' },
      timestamp: 1788696752960,
      message: {
        mid: 'LIVE_WITH_MEDIA',
        text: '',
        attachments: [{ type: 'image', payload: { url: 'https://x.test/a.jpg' } }],
      },
    });

    const stored: { metadata: Record<string, unknown> }[] = await db.query(
      `SELECT metadata FROM messages WHERE platform_message_id = 'LIVE_WITH_MEDIA'`,
    );
    expect(stored[0]?.metadata.contentUnavailable).toBeUndefined();
  });
});
