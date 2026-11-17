import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { MessageRepository } from '@/database/repositories/message.repository';
import { renderTurnText } from '@/modules/inbox/turn-text';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * What a replay is given to rebuild a prompt with.
 *
 * THE HALF A SHARED RENDERER CANNOT FIX. The assistant and the replay now
 * render a turn through one function, so they cannot disagree about HOW to
 * render one — but they read the thread through two different queries, and
 * a renderer handed less data produces less text while looking perfectly
 * correct. That is precisely how this broke: `findByRefIds` never selected
 * `metadata` or the parent, so every replayed turn lost its reaction, the
 * assistant's own notes, and the marker saying what it answered.
 *
 * Nothing failed. The replay showed a prompt the model never saw, to
 * somebody who had opened it to find out what the model saw — and because
 * the fingerprint is taken over that text, every reply in a thread with
 * notes in it reported as drifted, which teaches a reader to ignore the one
 * signal that says a replay cannot be trusted.
 */
describe('the messages a replay rebuilds from', () => {
  let db: DataSource;
  let messages: MessageRepository;
  let enterpriseId: number;
  let otherEnterpriseId: number;
  let conversationId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    messages = new MessageRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

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

  async function addMessage(
    tenant: number,
    conversation: number,
    direction: 'inbound' | 'outbound',
    body: string,
    metadata: Record<string, unknown>,
    parentId: number | null = null,
  ): Promise<{ id: number; refId: string }> {
    const row: { id: string; ref_id: string }[] = await db.query(
      `INSERT INTO messages
         (enterprise_id, conversation_id, direction, message_kind, body, status,
          metadata, parent_message_id)
       VALUES ($1,$2,$3,'text',$4,'delivered',$5::jsonb,$6) RETURNING id, ref_id`,
      [tenant, conversation, direction, body, JSON.stringify(metadata), parentId],
    );
    return { id: Number(row[0]?.id), refId: String(row[0]?.ref_id) };
  }

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    otherEnterpriseId = await seedEnterprise(db, 'Rival', 'rival');
    conversationId = await seedConversation(enterpriseId, 'thread-1');
  });

  it('hands back the notes, so a replayed turn carries them', async () => {
    const reply = await addMessage(enterpriseId, conversationId, 'outbound', 'two days', {
      assistant: { summary: 'they asked about delivery' },
    });

    const [row] = await messages.findByRefIds(enterpriseId, [reply.refId]);

    expect(row).toBeDefined();
    // Through the renderer, which is what the prompt actually contains.
    expect(renderTurnText(row!, [])).toContain('[notes: they asked about delivery]');
  });

  it('hands back a reaction, so a replayed turn carries that too', async () => {
    const reacted = await addMessage(enterpriseId, conversationId, 'inbound', 'thanks', {
      reaction: { emoji: '❤', name: 'love' },
    });

    const [row] = await messages.findByRefIds(enterpriseId, [reacted.refId]);
    expect(renderTurnText(row!, [])).toContain('[reaction: ❤ love]');
  });

  it('hands back the parent’s public id, which is what the turn marker needs', async () => {
    const parent = await addMessage(enterpriseId, conversationId, 'outbound', 'we are open', {});
    const child = await addMessage(enterpriseId, conversationId, 'inbound', 'great', {}, parent.id);

    const rows = await messages.findByRefIds(enterpriseId, [child.refId]);
    /*
     * `tagTurn` writes `re:<parent>` from this. It was never selected, so
     * every replayed reply read as a loose message — on a platform where
     * "yes" means agreement or an answer to a question four messages back,
     * and nothing in the words tells the two apart.
     */
    expect(rows[0]?.parentRefId).toBe(parent.refId);
  });

  it('leaves parentRefId null for a parent we never received', async () => {
    const orphan = await addMessage(enterpriseId, conversationId, 'inbound', 'yes', {
      replyToPlatformMessageId: 'mid-we-do-not-hold',
    });

    const rows = await messages.findByRefIds(enterpriseId, [orphan.refId]);
    expect(rows[0]?.parentRefId).toBeNull();
  });

  it('will not hand one business another business’s messages', async () => {
    const mine = await addMessage(enterpriseId, conversationId, 'outbound', 'ours', {
      assistant: { summary: 'our private understanding of this customer' },
    });

    expect(await messages.findByRefIds(otherEnterpriseId, [mine.refId])).toEqual([]);
  });

  it('asks for nothing when there are no ids', async () => {
    expect(await messages.findByRefIds(enterpriseId, [])).toEqual([]);
  });
});
