import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
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
