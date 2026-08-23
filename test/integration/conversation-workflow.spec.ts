import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
import { ConversationKind, ConversationStatus, Platform } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * Assigning a conversation and closing it — the two writes that make a shared
 * inbox shared.
 *
 * setStatus had NEVER worked. It bound one parameter both as a column value and
 * as the operand of an `IN (...)`, which Postgres refuses outright with
 * "inconsistent types deduced for parameter $3" — so every request to that
 * endpoint, for the whole life of the branch, answered 500. Nothing caught it:
 * no UI called it and no test covered it, and a repository unit test with a
 * mocked driver would have passed happily.
 *
 * That is the argument for testing this against real Postgres rather than at
 * all.
 */
describe('conversation assignment and status', () => {
  let db: DataSource;
  let conversations: ConversationRepository;
  let enterpriseId: number;
  let channelId: number;
  let customerId: number;
  let employeeId: number;
  let conversationId: number;
  let conversationRefId: string;

  beforeAll(async () => {
    db = await createTestDataSource();
    conversations = new ConversationRepository(db);
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

    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
       VALUES ($1,'Someone','facebook_comment',$2) RETURNING id`,
      [enterpriseId, channelId],
    );
    customerId = Number(customer[0]?.id);

    const identity: { id: string }[] = await db.query(
      `INSERT INTO identities (email, password_hash, first_name, last_name)
       VALUES ('agent@example.test','$argon2id$not-real','Ada','Lovelace') RETURNING id`,
    );
    const employee: { id: string }[] = await db.query(
      `INSERT INTO enterprise_employees (enterprise_id, identity_id, employee_kind, status)
       VALUES ($1,$2,'business','active') RETURNING id`,
      [enterpriseId, identity[0]?.id],
    );
    employeeId = Number(employee[0]?.id);

    const created = await conversations.upsert({
      enterpriseId,
      channelId,
      customerId,
      customerIdentifierId: null,
      postId: null,
      platform: Platform.Facebook,
      conversationKind: ConversationKind.CommentThread,
      platformThreadId: 'comment:1',
      subject: null,
    });
    conversationId = created.id;
    conversationRefId = created.refId;
  });

  const read = async () => {
    const row = await conversations.findByRefId(enterpriseId, conversationRefId);
    if (!row) throw new Error('the conversation vanished');
    return row;
  };

  it('starts open and unassigned', async () => {
    const row = await read();
    expect(row.status).toBe(ConversationStatus.Open);
    expect(row.assignedToEmployeeId).toBeNull();
    expect(row.assignedToRefId).toBeNull();
  });

  it('resolves a conversation and stamps when', async () => {
    await conversations.setStatus(enterpriseId, conversationId, ConversationStatus.Resolved);

    expect((await read()).status).toBe(ConversationStatus.Resolved);
    const rows: { resolved_at: Date | null }[] = await db.query(
      `SELECT resolved_at FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(rows[0]?.resolved_at).not.toBeNull();
  });

  it('clears the resolved stamp on reopening', async () => {
    await conversations.setStatus(enterpriseId, conversationId, ConversationStatus.Resolved);
    await conversations.setStatus(enterpriseId, conversationId, ConversationStatus.Open);

    const rows: { resolved_at: Date | null }[] = await db.query(
      `SELECT resolved_at FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(rows[0]?.resolved_at).toBeNull();
  });

  it.each([
    ConversationStatus.Open,
    ConversationStatus.Pending,
    ConversationStatus.Resolved,
    ConversationStatus.Closed,
    ConversationStatus.Archived,
  ])('accepts %s', async (status) => {
    // Every value in the enum, because the defect was in parameter binding and
    // would have shown on all of them equally.
    await conversations.setStatus(enterpriseId, conversationId, status);
    expect((await read()).status).toBe(status);
  });

  it('assigns to a colleague and reads the name back', async () => {
    await conversations.assign(enterpriseId, conversationId, employeeId);

    const row = await read();
    expect(row.assignedToEmployeeId).toBe(employeeId);
    expect(row.assignedToRefId).not.toBeNull();
    // Joined, so the inbox can show who has it without a query per row.
    expect(row.assignedToName).toBe('Ada Lovelace');
  });

  it('unassigns, and clears the stamp with it', async () => {
    await conversations.assign(enterpriseId, conversationId, employeeId);
    await conversations.assign(enterpriseId, conversationId, null);

    const row = await read();
    expect(row.assignedToEmployeeId).toBeNull();
    expect(row.assignedToName).toBeNull();

    const rows: { assigned_at: Date | null }[] = await db.query(
      `SELECT assigned_at FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(rows[0]?.assigned_at).toBeNull();
  });

  it('surfaces the assignee in the inbox list too', async () => {
    await conversations.assign(enterpriseId, conversationId, employeeId);

    const [row] = await conversations.listInbox({
      enterpriseId,
      status: null,
      assignedToEmployeeId: employeeId,
      limit: 10,
      cursor: null,
    });

    // Both halves matter: the filter finding it, and the row carrying the name.
    // Before the join, "assigned to me" was permanently empty.
    expect(row?.id).toBe(conversationId);
    expect(row?.assignedToName).toBe('Ada Lovelace');
  });

  it('will not touch another tenant’s conversation', async () => {
    const otherEnterpriseId = await seedEnterprise(db, 'Rival', 'rival');

    await conversations.setStatus(otherEnterpriseId, conversationId, ConversationStatus.Closed);
    await conversations.assign(otherEnterpriseId, conversationId, employeeId);

    const row = await read();
    expect(row.status).toBe(ConversationStatus.Open);
    expect(row.assignedToEmployeeId).toBeNull();
  });
});
