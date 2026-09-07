import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { ConversationKind, ConversationStatus, Platform } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * Keyset pagination, against real Postgres — the only place these two defects
 * are visible.
 *
 * Both are the same mistake in different clothes: a keyset that does not match
 * the ORDER BY it is paginating. Neither errors, neither logs, and both present
 * as "some rows are just missing", which is why they need tests rather than a
 * reading.
 */
describe('keyset pagination', () => {
  let db: DataSource;
  let conversations: ConversationRepository;
  let messages: MessageRepository;
  let enterpriseId: number;
  let channelId: number;
  let customerId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    conversations = new ConversationRepository(db);
    messages = new MessageRepository(db);
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
       VALUES ($1,$2,'facebook','page','PAGE_1') RETURNING id`,
      [connection[0]?.id, enterpriseId],
    );
    channelId = Number(channel[0]?.id);

    // conversations.customer_id is NOT NULL: every thread belongs to somebody.
    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
       VALUES ($1,'Someone','comment',$2) RETURNING id`,
      [enterpriseId, channelId],
    );
    customerId = Number(customer[0]?.id);
  });

  describe('the inbox list', () => {
    const newConversation = async (threadId: string, lastMessageAt: string | null) => {
      const { id } = await conversations.upsert({
        enterpriseId,
        channelId,
        customerId,
        customerIdentifierId: null,
        postId: null,
        platform: Platform.Facebook,
        conversationKind: ConversationKind.CommentThread,
        platformThreadId: threadId,
        subject: null,
      });
      await db.query(`UPDATE conversations SET last_message_at = $2 WHERE id = $1`, [
        id,
        lastMessageAt,
      ]);
      return id;
    };

    it('lists conversations with no messages yet, on every page', async () => {
      /*
       * The defect: `(last_message_at, id) < ($1, $2)` yields NULL — not true —
       * for every row whose last_message_at is null, so ORDER BY ... NULLS LAST
       * put those rows on the later pages and the keyset then filtered every one
       * of them out. They were unreachable through the API entirely.
       */
      await newConversation('comment:1', '2026-01-03T00:00:00Z');
      await newConversation('comment:2', '2026-01-02T00:00:00Z');
      const quietA = await newConversation('comment:3', null);
      const quietB = await newConversation('comment:4', null);

      const pageOne = await conversations.listInbox({
        enterpriseId,
        status: null,
        assignedToEmployeeId: null,
      conversationKind: null,
        limit: 2,
        cursor: null,
      });
      expect(pageOne).toHaveLength(2);

      const anchor = pageOne[1];
      const pageTwo = await conversations.listInbox({
        enterpriseId,
        status: null,
        assignedToEmployeeId: null,
      conversationKind: null,
        limit: 2,
        cursor: { lastMessageAt: anchor?.lastMessageAt ?? null, id: anchor?.id ?? 0 },
      });

      expect(pageTwo.map((row) => row.id).sort()).toEqual([quietA, quietB].sort());
    });

    it('pages past a null-keyed row by id, without repeating it', async () => {
      // A page that ENDS on a null row mints a cursor whose timestamp is null,
      // which the third branch of the predicate has to handle on its own.
      const first = await newConversation('comment:1', null);
      const second = await newConversation('comment:2', null);
      const third = await newConversation('comment:3', null);

      const pageOne = await conversations.listInbox({
        enterpriseId,
        status: null,
        assignedToEmployeeId: null,
      conversationKind: null,
        limit: 1,
        cursor: null,
      });
      // NULLS LAST with id DESC: the newest null row comes first.
      expect(pageOne[0]?.id).toBe(third);

      const pageTwo = await conversations.listInbox({
        enterpriseId,
        status: null,
        assignedToEmployeeId: null,
      conversationKind: null,
        limit: 5,
        cursor: { lastMessageAt: null, id: third },
      });
      expect(pageTwo.map((row) => row.id)).toEqual([second, first]);
    });
  });

  describe('a message thread', () => {
    let conversationId: number;

    beforeEach(async () => {
      const { id } = await conversations.upsert({
        enterpriseId,
        channelId,
        customerId,
        customerIdentifierId: null,
        postId: null,
        platform: Platform.Facebook,
        conversationKind: ConversationKind.CommentThread,
        platformThreadId: 'comment:thread',
        subject: null,
      });
      conversationId = id;
      await db.query(`UPDATE conversations SET status = $2 WHERE id = $1`, [
        id,
        ConversationStatus.Open,
      ]);
    });

    /**
     * Inserted directly, because the point is to make the id order DISAGREE with
     * the timestamp order — exactly what the backfill worker does when it
     * appends years-old history long after today's webhooks have arrived.
     */
    const addMessage = async (platformSentAt: string): Promise<number> => {
      const rows: { id: string }[] = await db.query(
        `INSERT INTO messages
           (enterprise_id, conversation_id, direction, message_kind, body, status,
            platform_sent_at)
         VALUES ($1,$2,'inbound','text',$3,'delivered',$4) RETURNING id`,
        [enterpriseId, conversationId, `at ${platformSentAt}`, platformSentAt],
      );
      return Number(rows[0]?.id);
    };

    it('pages in timestamp order even when ids disagree with it', async () => {
      // Today's webhook arrives first and gets the LOWEST id; the backfill then
      // appends last year's messages with HIGHER ids.
      const live = await addMessage('2026-06-01T12:00:00Z');
      const oldA = await addMessage('2025-01-01T00:00:00Z');
      const oldB = await addMessage('2025-01-02T00:00:00Z');

      const pageOne = await messages.listThread(enterpriseId, conversationId, 1, null);
      expect(pageOne.map((row) => row.id)).toEqual([live]);

      const anchor = pageOne[0];
      const pageTwo = await messages.listThread(enterpriseId, conversationId, 10, {
        sortedAt: anchor?.platformSentAt ?? new Date(),
        id: anchor?.id ?? 0,
      });

      /*
       * The old `AND id < $n` keyset asked for ids below the live message's id —
       * and both backfilled messages have HIGHER ids, so page two came back
       * empty and half the thread was unreadable.
       */
      expect(pageTwo.map((row) => row.id)).toEqual([oldB, oldA]);
    });

    it('translates the deprecated beforeId into the real sort position', async () => {
      const live = await addMessage('2026-06-01T12:00:00Z');
      const older = await addMessage('2025-01-01T00:00:00Z');

      const position = await messages.findThreadPosition(enterpriseId, conversationId, live);
      expect(position).not.toBeNull();

      const rest = await messages.listThread(enterpriseId, conversationId, 10, position);
      expect(rest.map((row) => row.id)).toEqual([older]);
    });

    it('does not resolve a position for a message in another conversation', async () => {
      // The lookup is tenant- AND conversation-scoped, so a guessed id from
      // elsewhere cannot be used to page someone else's thread.
      const mine = await addMessage('2026-06-01T12:00:00Z');
      expect(
        await messages.findThreadPosition(enterpriseId, conversationId + 999, mine),
      ).toBeNull();
    });
  });
});
