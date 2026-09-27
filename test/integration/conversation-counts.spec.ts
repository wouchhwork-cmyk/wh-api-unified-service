import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { ConversationKind, Platform } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The two conversation counters, which had never been written to.
 *
 * Both were declared DEFAULT 0 and no code incremented either, so they read 0
 * for every customer who had ever had a conversation — beside message counts
 * that WERE maintained, which is exactly what made them believable. These
 * assertions are the thing that stops that happening again.
 */
describe('conversation counters', () => {
  let db: DataSource;
  let conversations: ConversationRepository;
  let customers: CustomerRepository;
  let enterpriseId: number;
  let channelId: number;
  let otherChannelId: number;
  let customerId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    conversations = new ConversationRepository(db);
    customers = new CustomerRepository(db);
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
    const channels: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
       VALUES ($1,$2,'instagram','instagram_business','IG_1'),
              ($1,$2,'facebook','page','PAGE_1')
       RETURNING id`,
      [connection[0]?.id, enterpriseId],
    );
    channelId = Number(channels[0]?.id);
    otherChannelId = Number(channels[1]?.id);

    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
       VALUES ($1,'someone','instagram_dm',$2) RETURNING id`,
      [enterpriseId, channelId],
    );
    customerId = Number(customer[0]?.id);
  });

  const open = (threadId: string, channel = channelId) =>
    conversations.upsert({
      enterpriseId,
      channelId: channel,
      customerId,
      customerIdentifierId: null,
      postId: null,
      platform: Platform.Instagram,
      conversationKind: ConversationKind.DirectMessage,
      platformThreadId: threadId,
      subject: null,
    });

  const countOnCustomer = async (): Promise<number> => {
    const rows: { conversation_count: number }[] = await db.query(
      `SELECT conversation_count FROM customers WHERE id = $1`,
      [customerId],
    );
    return rows[0]?.conversation_count ?? -1;
  };

  it('counts a conversation when it is opened', async () => {
    expect(await countOnCustomer()).toBe(0);
    await open('dm:1');
    expect(await countOnCustomer()).toBe(1);
  });

  it('does not count the second message in the same thread', async () => {
    // The upsert runs for EVERY message, so this is the whole difficulty: only
    // the one that created the row may count.
    await open('dm:1');
    await open('dm:1');
    await open('dm:1');
    expect(await countOnCustomer()).toBe(1);
  });

  it('reports whether the thread was created', async () => {
    const first = await open('dm:1');
    const second = await open('dm:1');

    expect(first.created).toBe(true);
    // xmax tells insert from update; RETURNING alone looks identical for both.
    expect(second.created).toBe(false);
  });

  it('counts separate threads separately', async () => {
    await open('dm:1');
    await open('comment:99');
    expect(await countOnCustomer()).toBe(2);
  });

  it('counts per channel in the engagement rollup', async () => {
    // The same person reached through two channels is two rows, and each one
    // counts only its own threads.
    const first = await open('dm:1');
    await customers.recordEngagement({
      enterpriseId,
      customerId,
      channelId,
      platform: Platform.Instagram,
      inbound: true,
      conversationId: first.id,
      conversationCreated: first.created,
    });
    const second = await open('dm:2', otherChannelId);
    await customers.recordEngagement({
      enterpriseId,
      customerId,
      channelId: otherChannelId,
      platform: Platform.Facebook,
      inbound: true,
      conversationId: second.id,
      conversationCreated: second.created,
    });

    const rows: { channel_id: string; conversation_count: number }[] = await db.query(
      `SELECT channel_id, conversation_count FROM customer_engagements
        WHERE customer_id = $1 ORDER BY channel_id`,
      [customerId],
    );
    expect(rows.map((row) => row.conversation_count)).toEqual([1, 1]);
  });

  it('does not count a reply as a new conversation', async () => {
    const conversation = await open('dm:1');
    await customers.recordEngagement({
      enterpriseId,
      customerId,
      channelId,
      platform: Platform.Instagram,
      inbound: true,
      conversationId: conversation.id,
      conversationCreated: conversation.created,
    });
    // An outbound reply: same thread, and the caller passes no flag at all.
    await customers.recordEngagement({
      enterpriseId,
      customerId,
      channelId,
      platform: Platform.Instagram,
      inbound: false,
      conversationId: conversation.id,
    });

    const rows: { conversation_count: number; outbound_message_count: number }[] = await db.query(
      `SELECT conversation_count, outbound_message_count FROM customer_engagements
        WHERE customer_id = $1 AND channel_id = $2`,
      [customerId, channelId],
    );
    expect(rows[0]?.conversation_count).toBe(1);
    expect(rows[0]?.outbound_message_count).toBe(1);
  });
});

/**
 * Deleting a comment must not make the thread and its own counter disagree.
 *
 * WRITTEN BECAUSE BOTH DELETE PATHS ERASED THE ROW. They set `is_deleted` —
 * our own soft-delete flag, which every read filters on — while nothing
 * decremented `conversations.message_count`. The summary went on saying three
 * over a thread showing two, for ever, with nothing to reconcile them. The
 * business also lost the record of what was said on their own post, which is
 * the one thing they are accountable for.
 *
 * A DM unsend has always done this correctly: mark it, keep it. These two now
 * follow the same rule, and the distinction is not pedantic —
 * `platform_deleted_at` means "gone from Instagram", `is_deleted` means "gone
 * from this product", and only the first one happened.
 */
describe('deleting a comment', () => {
  let db: DataSource;
  let messages: MessageRepository;
  let enterpriseId: number;
  let channelId: number;
  let customerId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    messages = new MessageRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  let conversationId: number;
  let messageId: number;
  const PLATFORM_ID = 'IG_COMMENT_DELETED';

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

    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
       VALUES ($1,'someone','instagram_comment',$2) RETURNING id`,
      [enterpriseId, channelId],
    );
    customerId = Number(customer[0]?.id);

    const conversation: { id: string }[] = await db.query(
      `INSERT INTO conversations
         (enterprise_id, channel_id, customer_id, platform, conversation_kind,
          platform_thread_id, status, message_count)
       VALUES ($1,$2,$3,'instagram','comment_thread','comment:ROOT','open',1)
       RETURNING id`,
      [enterpriseId, channelId, customerId],
    );
    conversationId = Number(conversation[0]?.id);

    const message: { id: string }[] = await db.query(
      `INSERT INTO messages
         (enterprise_id, conversation_id, customer_id, direction, message_kind,
          body, platform_message_id, status)
       VALUES ($1,$2,$3,'inbound','text','what they said',$4,'delivered')
       RETURNING id`,
      [enterpriseId, conversationId, customerId, PLATFORM_ID],
    );
    messageId = Number(message[0]?.id);
  });

  const stored = async (): Promise<{
    isDeleted: boolean;
    platformDeletedAt: Date | null;
    body: string | null;
  }> => {
    const rows: { is_deleted: boolean; platform_deleted_at: Date | null; body: string | null }[] =
      await db.query(
        `SELECT is_deleted, platform_deleted_at, body FROM messages WHERE id = $1`,
        [messageId],
      );
    const row = rows[0];
    return {
      isDeleted: row?.is_deleted ?? false,
      platformDeletedAt: row?.platform_deleted_at ?? null,
      body: row?.body ?? null,
    };
  };

  /** What a thread read would return: the counter's promise, checked. */
  const stillVisible = async (): Promise<number> => {
    const rows: { n: string }[] = await db.query(
      `SELECT count(*)::text AS n FROM messages
        WHERE conversation_id = $1 AND is_deleted = false`,
      [conversationId],
    );
    return Number(rows[0]?.n ?? 0);
  };

  it('marks a platform removal without erasing the row', async () => {
    await messages.applyPlatformModeration({
      enterpriseId,
      platformMessageId: PLATFORM_ID,
      action: 'removed',
      text: null,
    });

    const after = await stored();
    expect(after.platformDeletedAt).not.toBeNull();
    // The flag every read filters on must NOT move.
    expect(after.isDeleted).toBe(false);
    // And the words stay: the business is accountable for the conversation.
    expect(after.body).toBe('what they said');
  });

  it('leaves the thread and its counter agreeing', async () => {
    /*
     * THE ASSERTION THAT CAUGHT IT. Erasing the row left message_count
     * counting a message the thread no longer returned.
     */
    await messages.applyPlatformModeration({
      enterpriseId,
      platformMessageId: PLATFORM_ID,
      action: 'removed',
      text: null,
    });

    const counter: { message_count: number }[] = await db.query(
      `SELECT message_count FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(await stillVisible()).toBe(Number(counter[0]?.message_count));
  });

  it('does the same when the BUSINESS deletes it', async () => {
    await messages.applyOwnModeration({ enterpriseId, messageId, action: 'delete' });

    const after = await stored();
    expect(after.platformDeletedAt).not.toBeNull();
    expect(after.isDeleted).toBe(false);
    expect(await stillVisible()).toBe(1);
  });

  it('does not confuse HIDING with deleting', async () => {
    // Hidden means the public cannot see it. It is still there and it comes
    // back — conflating the two would make unhide impossible.
    await messages.applyOwnModeration({ enterpriseId, messageId, action: 'hide' });

    const after = await stored();
    expect(after.platformDeletedAt).toBeNull();
    expect(after.isDeleted).toBe(false);
  });
});
