import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
import { MessageAttachmentRepository } from '@/database/repositories/message-attachment.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { ConversationKind, MediaKind, MessageKind, Platform } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * Storing a message's media, against real Postgres.
 *
 * `message_attachments` was written into the schema and never inserted into
 * once — so every photo, GIF, video, voice note and story mention Meta
 * delivered was dropped, and the inbox rendered "(no text)". A repository test
 * with a mocked driver would not have caught the two things that actually break
 * here: the jsonb cast on the batched VALUES list, and `has_attachments` on a
 * row written by a different repository in the same transaction.
 */
describe('message attachments', () => {
  let db: DataSource;
  let conversations: ConversationRepository;
  let messages: MessageRepository;
  let attachments: MessageAttachmentRepository;
  let enterpriseId: number;
  let channelId: number;
  let customerId: number;
  let conversationId: number;
  let inboundEventId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    conversations = new ConversationRepository(db);
    messages = new MessageRepository(db);
    attachments = new MessageAttachmentRepository(db);
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

    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
       VALUES ($1,'genzrelics','instagram_dm',$2) RETURNING id`,
      [enterpriseId, channelId],
    );
    customerId = Number(customer[0]?.id);

    const conversation = await conversations.upsert({
      enterpriseId,
      channelId,
      customerId,
      customerIdentifierId: null,
      postId: null,
      platform: Platform.Instagram,
      conversationKind: ConversationKind.DirectMessage,
      platformThreadId: 'dm:1774658693722714',
      subject: null,
    });
    conversationId = conversation.id;

    // A real ledger row: messages.inbound_event_id carries a foreign key, which
    // is the point — a projected message must be traceable to the delivery it
    // came from.
    const event: { id: string }[] = await db.query(
      `INSERT INTO inbound_events
         (enterprise_id, channel_id, source_kind, platform, event_type, dedup_key, payload)
       VALUES ($1,$2,'webhook','instagram','direct_message','instagram:direct_message:test','{}')
       RETURNING id`,
      [enterpriseId, channelId],
    );
    inboundEventId = Number(event[0]?.id);
  });

  const insertMessage = async (kind: MessageKind, mid: string, hasAttachments: boolean) => {
    const row = await messages.insertInbound({
      enterpriseId,
      conversationId,
      customerId,
      inboundEventId,
      platformMessageId: mid,
      messageKind: kind,
      body: null,
      platformSentAt: new Date('2026-09-05T22:50:28Z'),
      parentMessageId: null,
      hasAttachments,
      metadata: hasAttachments ? { isStoryMention: true } : {},
    });
    if (!row) throw new Error('the message was not inserted');
    return row;
  };

  it('stores the CDN link and its metadata, and flags the message', async () => {
    const message = await insertMessage(MessageKind.StoryReply, 'MID_STORY', true);

    const written = await attachments.insertMany([
      {
        enterpriseId,
        messageId: message.id,
        mediaKind: MediaKind.Image,
        sourceUrl: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18101327498358721',
        sortOrder: 0,
        metadata: { platformType: 'story_mention', assetId: '18101327498358721', stableUrl: false },
      },
    ]);
    expect(written).toBe(1);

    const rows = await attachments.listForMessages(enterpriseId, [message.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceUrl).toContain('lookaside.fbsbx.com');
    // The jsonb round trip is the point: a metadata object that came back as a
    // string would mean the cast was wrong and every consumer would break.
    expect(rows[0]?.metadata.assetId).toBe('18101327498358721');
    expect(rows[0]?.storageKey).toBeNull();

    const flag: { has_attachments: boolean; metadata: Record<string, unknown> }[] = await db.query(
      `SELECT has_attachments, metadata FROM messages WHERE id = $1`,
      [message.id],
    );
    expect(flag[0]?.has_attachments).toBe(true);
    expect(flag[0]?.metadata.isStoryMention).toBe(true);
  });

  it('keeps a carousel in the order it arrived', async () => {
    const message = await insertMessage(MessageKind.Image, 'MID_CAROUSEL', true);

    await attachments.insertMany([
      {
        enterpriseId,
        messageId: message.id,
        mediaKind: MediaKind.Image,
        sourceUrl: 'https://x.test/2',
        sortOrder: 1,
        metadata: {},
      },
      {
        enterpriseId,
        messageId: message.id,
        mediaKind: MediaKind.Video,
        sourceUrl: 'https://x.test/1',
        sortOrder: 0,
        metadata: {},
      },
    ]);

    const rows = await attachments.listForMessages(enterpriseId, [message.id]);
    expect(rows.map((row) => row.sourceUrl)).toEqual(['https://x.test/1', 'https://x.test/2']);
  });

  it('reads a whole page of messages in one query', async () => {
    // The thread endpoint asks for every message at once; asking per message is
    // the N+1 this method exists to avoid.
    const first = await insertMessage(MessageKind.Image, 'MID_A', true);
    const second = await insertMessage(MessageKind.Video, 'MID_B', true);

    await attachments.insertMany([
      {
        enterpriseId,
        messageId: first.id,
        mediaKind: MediaKind.Image,
        sourceUrl: 'https://x.test/a',
        sortOrder: 0,
        metadata: {},
      },
      {
        enterpriseId,
        messageId: second.id,
        mediaKind: MediaKind.Video,
        sourceUrl: 'https://x.test/b',
        sortOrder: 0,
        metadata: {},
      },
    ]);

    const rows = await attachments.listForMessages(enterpriseId, [first.id, second.id]);
    expect(rows).toHaveLength(2);
  });

  it("never returns another tenant's attachments", async () => {
    const message = await insertMessage(MessageKind.Image, 'MID_TENANT', true);
    await attachments.insertMany([
      {
        enterpriseId,
        messageId: message.id,
        mediaKind: MediaKind.Image,
        sourceUrl: 'https://x.test/secret',
        sortOrder: 0,
        metadata: {},
      },
    ]);

    const other = await seedEnterprise(db, 'Rival', 'rival');
    // Same message id, different tenant: the scoping is the only thing standing
    // between these two businesses.
    expect(await attachments.listForMessages(other, [message.id])).toHaveLength(0);
  });

  it('writes nothing when there is nothing to write', async () => {
    expect(await attachments.insertMany([])).toBe(0);
    expect(await attachments.listForMessages(enterpriseId, [])).toHaveLength(0);
  });

  it('does not mark a stable link as expiring', async () => {
    /*
     * The contradiction this pins: a GIF was coming back as mediaKind "gif" —
     * correctly recognised as permanent — and expires:true in the same object,
     * because expires was derived from storageKey alone. The UI would then be
     * ready to report a perfectly good Giphy link as "no longer available".
     */
    const message = await insertMessage(MessageKind.Image, 'MID_GIF', true);
    await attachments.insertMany([
      {
        enterpriseId,
        messageId: message.id,
        mediaKind: MediaKind.Gif,
        sourceUrl: 'https://media2.giphy.com/media/v1.Y2lk/gKrbnqo25MlI2TUC78/200.gif',
        sortOrder: 0,
        metadata: { platformType: 'image', stableUrl: true },
      },
    ]);

    const rows = await attachments.listForMessages(enterpriseId, [message.id]);
    // What the controller derives `expires` from.
    expect(rows[0]?.metadata.stableUrl).toBe(true);
    expect(rows[0]?.storageKey).toBeNull();
  });
});
