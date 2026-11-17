import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { MessageRepository } from '@/database/repositories/message.repository';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The running notes, read backwards — against real Postgres, because every
 * one of these answers comes out of a JSONB path and an id boundary that no
 * mock can get wrong on our behalf.
 *
 * What is actually being guarded:
 *
 *   - `<=` rather than `<`. A reply's own notes ARE the answer to "what did
 *     it know when it said this?", and the replay path next door deliberately
 *     uses the other boundary. One character apart, both plausible, and a
 *     wrong one answers confidently with the previous reply's notes.
 *   - The newest qualifying row wins. The notes are rewritten on every reply,
 *     so "a message with notes before this one" is a set, not a row.
 *   - Tenant and conversation scope, on both queries. These read a customer's
 *     conversation summarised in prose; a ref from another thread must not
 *     reach it.
 */
describe('reading the notes at a message', () => {
  let db: DataSource;
  let messages: MessageRepository;
  let enterpriseId: number;
  let otherEnterpriseId: number;
  let conversationId: number;
  let otherConversationId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    messages = new MessageRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  /** A thread with nothing in it, ready to be filled message by message. */
  async function seedConversation(tenant: number, threadId: string): Promise<number> {
    const connection: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social',$2,'envelope') RETURNING id`,
      [tenant, `fbu-${threadId}`],
    );
    const channel: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
       VALUES ($1,$2,'instagram','page',$3) RETURNING id`,
      [connection[0]?.id, tenant, `PAGE-${threadId}`],
    );
    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
       VALUES ($1,'Someone','direct_message',$2) RETURNING id`,
      [tenant, channel[0]?.id],
    );
    const conversation: { id: string }[] = await db.query(
      `INSERT INTO conversations
         (enterprise_id, channel_id, customer_id, platform, conversation_kind,
          platform_thread_id, status)
       VALUES ($1,$2,$3,'instagram','direct_message',$4,'open') RETURNING id`,
      [tenant, channel[0]?.id, customer[0]?.id, threadId],
    );
    return Number(conversation[0]?.id);
  }

  /**
   * One message. `notes` null is everything the assistant did not write — a
   * customer's message, or one a colleague typed into Instagram.
   */
  async function addMessage(
    tenant: number,
    conversation: number,
    direction: 'inbound' | 'outbound',
    body: string,
    notes: string | null,
  ): Promise<{ id: number; refId: string }> {
    const metadata = notes === null ? {} : { assistant: { summary: notes } };
    const row: { id: string; ref_id: string }[] = await db.query(
      `INSERT INTO messages
         (enterprise_id, conversation_id, direction, message_kind, body, status, metadata)
       VALUES ($1,$2,$3,'text',$4,'delivered',$5::jsonb) RETURNING id, ref_id`,
      [tenant, conversation, direction, body, JSON.stringify(metadata)],
    );
    return { id: Number(row[0]?.id), refId: String(row[0]?.ref_id) };
  }

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    otherEnterpriseId = await seedEnterprise(db, 'Rival', 'rival');
    conversationId = await seedConversation(enterpriseId, 'thread-1');
    otherConversationId = await seedConversation(enterpriseId, 'thread-2');
  });

  it('answers with the notes the message itself wrote', async () => {
    await addMessage(enterpriseId, conversationId, 'inbound', 'do you deliver?', null);
    const reply = await addMessage(
      enterpriseId,
      conversationId,
      'outbound',
      'we do, two days',
      'They asked about delivery; we said two days.',
    );

    const notes = await messages.notesAsOf(enterpriseId, conversationId, reply.id);

    expect(notes?.summary).toBe('They asked about delivery; we said two days.');
    expect(notes?.isSameMessage).toBe(true);
    expect(notes?.refId).toBe(reply.refId);
  });

  it('carries the last notes forward to a message the business typed itself', async () => {
    const first = await addMessage(
      enterpriseId,
      conversationId,
      'outbound',
      'two days',
      'They asked about delivery.',
    );
    const manual = await addMessage(
      enterpriseId,
      conversationId,
      'outbound',
      'sent from the app',
      null,
    );

    const notes = await messages.notesAsOf(enterpriseId, conversationId, manual.id);

    expect(notes?.summary).toBe('They asked about delivery.');
    // Said out loud, because the summary has NOT read the message being asked
    // about and a reader needs to know how far behind it is.
    expect(notes?.isSameMessage).toBe(false);
    expect(notes?.refId).toBe(first.refId);
  });

  it('takes the newest notes at or before the message, never an older set', async () => {
    const first = await addMessage(enterpriseId, conversationId, 'outbound', 'a', 'first notes');
    const second = await addMessage(enterpriseId, conversationId, 'outbound', 'b', 'second notes');
    const third = await addMessage(enterpriseId, conversationId, 'outbound', 'c', 'third notes');

    expect((await messages.notesAsOf(enterpriseId, conversationId, first.id))?.summary).toBe(
      'first notes',
    );
    expect((await messages.notesAsOf(enterpriseId, conversationId, second.id))?.summary).toBe(
      'second notes',
    );
    expect((await messages.notesAsOf(enterpriseId, conversationId, third.id))?.summary).toBe(
      'third notes',
    );
  });

  it('has no answer before anything was summarised', async () => {
    const opening = await addMessage(enterpriseId, conversationId, 'inbound', 'hello', null);
    await addMessage(enterpriseId, conversationId, 'outbound', 'hi', 'the first notes');

    expect(await messages.notesAsOf(enterpriseId, conversationId, opening.id)).toBeNull();
  });

  it('will not read another tenant’s notes with a message id', async () => {
    const reply = await addMessage(
      enterpriseId,
      conversationId,
      'outbound',
      'ours',
      'our private understanding of this customer',
    );

    expect(await messages.notesAsOf(otherEnterpriseId, conversationId, reply.id)).toBeNull();
  });

  it('will not read another thread’s notes through this conversation', async () => {
    const elsewhere = await addMessage(
      enterpriseId,
      otherConversationId,
      'outbound',
      'other thread',
      'notes about somebody else',
    );

    expect(await messages.notesAsOf(enterpriseId, conversationId, elsewhere.id)).toBeNull();
  });

  describe('where the notes begin', () => {
    it('names the first message that carries them', async () => {
      await addMessage(enterpriseId, conversationId, 'inbound', 'hello', null);
      const first = await addMessage(enterpriseId, conversationId, 'outbound', 'hi', 'notes one');
      await addMessage(enterpriseId, conversationId, 'outbound', 'more', 'notes two');

      expect(await messages.firstSummaryMessageId(enterpriseId, conversationId)).toBe(first.id);
    });

    it('is null for a thread the assistant has never written in', async () => {
      await addMessage(enterpriseId, conversationId, 'inbound', 'hello', null);
      await addMessage(enterpriseId, conversationId, 'outbound', 'hi', null);

      expect(await messages.firstSummaryMessageId(enterpriseId, conversationId)).toBeNull();
    });

    it('ignores a deleted message, which the thread no longer shows', async () => {
      const first = await addMessage(enterpriseId, conversationId, 'outbound', 'a', 'notes one');
      const second = await addMessage(enterpriseId, conversationId, 'outbound', 'b', 'notes two');
      await db.query(`UPDATE messages SET is_deleted = true WHERE id = $1`, [first.id]);

      expect(await messages.firstSummaryMessageId(enterpriseId, conversationId)).toBe(second.id);
    });

    it('stays within the conversation it was asked about', async () => {
      await addMessage(enterpriseId, otherConversationId, 'outbound', 'other', 'other notes');

      expect(await messages.firstSummaryMessageId(enterpriseId, conversationId)).toBeNull();
    });
  });

  describe('resolving a message by its public id', () => {
    it('finds one inside the conversation', async () => {
      const message = await addMessage(enterpriseId, conversationId, 'outbound', 'a', null);
      expect(await messages.findMessageIdByRef(enterpriseId, conversationId, message.refId)).toBe(
        message.id,
      );
    });

    it('refuses a ref that belongs to another thread', async () => {
      const elsewhere = await addMessage(enterpriseId, otherConversationId, 'outbound', 'b', null);
      expect(
        await messages.findMessageIdByRef(enterpriseId, conversationId, elsewhere.refId),
      ).toBeNull();
    });

    it('refuses a ref that belongs to another tenant', async () => {
      const message = await addMessage(enterpriseId, conversationId, 'outbound', 'a', null);
      expect(
        await messages.findMessageIdByRef(otherEnterpriseId, conversationId, message.refId),
      ).toBeNull();
    });
  });
});
