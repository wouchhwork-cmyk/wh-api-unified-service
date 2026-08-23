import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  createTestApp,
  platformAdminLogin,
  provisionPlatformAdmin,
  resetTenantData,
  type TestApp,
} from './app.harness';

/**
 * The shared inbox over HTTP: who has a conversation, and whether it is done.
 *
 * Both endpoints shipped with no client and no test, and the consequences were
 * exactly what that combination predicts. setStatus bound one parameter as both
 * a column value and an `IN (...)` operand, which Postgres refuses — so it
 * answered 500 for every request ever made to it. And nothing read the assignee
 * back, so "assigned to me" was permanently empty however many times anybody
 * pressed assign.
 *
 * A conversation needs a channel, a customer and a thread, so the fixtures go in
 * through the database. Everything under test goes through HTTP.
 */
const OWNER_PASSWORD = 'a-long-enough-password';
const SIGNUP = {
  business: { name: 'Blue Bottle Cafe', email: 'hello@bluebottle.test', city: 'Pune' },
  owner: {
    firstName: 'Meera',
    lastName: 'Iyer',
    email: 'meera@bluebottle.test',
    password: OWNER_PASSWORD,
  },
};

describe('the shared inbox', () => {
  let testApp: TestApp;
  let app: NestExpressApplication;
  let db: DataSource;

  beforeAll(async () => {
    testApp = await createTestApp();
    app = testApp.app;
    db = testApp.db;
  });
  afterAll(async () => {
    await testApp.close();
  });
  beforeEach(async () => {
    await resetTenantData(db);
    await provisionPlatformAdmin(app);
  });

  const http = () => request(app.getHttpServer());
  const code = (): string => process.env.OTP_STATIC_CODE ?? '666666';

  async function onboardedBusiness(): Promise<{ ownerToken: string; enterpriseRefId: string }> {
    const signup = await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);
    const verified = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId: signup.body.data.verificationRefId, code: code() })
      .expect(200);

    const admin = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
    const adminAuth = { Authorization: `Bearer ${admin.body.data.accessToken as string}` };

    await http()
      .post(`/api/v1/platform/enterprises/${signup.body.data.enterpriseRefId}/status`)
      .set(adminAuth)
      .send({ status: 'active' })
      .expect(200);

    // The inbox is feature-gated, and the gate is real: without this every
    // request below is a 403 rather than a failure of what is under test.
    await http()
      .post(
        `/api/v1/platform/enterprises/${signup.body.data.enterpriseRefId}/features/unified_inbox`,
      )
      .set(adminAuth)
      .send({ status: 'active' })
      .expect(200);

    return {
      ownerToken: verified.body.data.accessToken as string,
      enterpriseRefId: signup.body.data.enterpriseRefId as string,
    };
  }

  /** A channel, a customer and one comment thread with a message in it. */
  async function seedConversation(enterpriseRefId: string): Promise<string> {
    const enterprise: { id: string }[] = await db.query(
      `SELECT id FROM enterprises WHERE ref_id = $1`,
      [enterpriseRefId],
    );
    const enterpriseId = enterprise[0]?.id;

    const connection: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social','fbu','envelope') RETURNING id`,
      [enterpriseId],
    );
    const channel: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id, name)
       VALUES ($1,$2,'facebook','page','PAGE_1','Blue Bottle') RETURNING id`,
      [connection[0]?.id, enterpriseId],
    );
    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
       VALUES ($1,'Grace Hopper','facebook_comment',$2) RETURNING id`,
      [enterpriseId, channel[0]?.id],
    );
    const conversation: { ref_id: string; id: string }[] = await db.query(
      `INSERT INTO conversations
         (enterprise_id, channel_id, customer_id, platform, conversation_kind,
          platform_thread_id, status, message_count, last_message_at)
       VALUES ($1,$2,$3,'facebook','comment_thread','comment:1','open',1, now())
       RETURNING ref_id, id`,
      [enterpriseId, channel[0]?.id, customer[0]?.id],
    );
    await db.query(
      `INSERT INTO messages
         (enterprise_id, conversation_id, customer_id, direction, message_kind, body, status,
          platform_sent_at)
       VALUES ($1,$2,$3,'inbound','text','is this open on Sundays?','delivered', now())`,
      [enterpriseId, conversation[0]?.id, customer[0]?.id],
    );

    return conversation[0]?.ref_id as string;
  }

  it('tells the client who it is, so it can offer "assign to me"', async () => {
    const { ownerToken } = await onboardedBusiness();

    const me = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    // Without this the assign endpoint is unusable from a client: it speaks in
    // refIds and nothing told the client what its own was.
    expect(me.body.data.employeeRefId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('lists a conversation as unassigned, and says who has it once assigned', async () => {
    const { ownerToken, enterpriseRefId } = await onboardedBusiness();
    const refId = await seedConversation(enterpriseRefId);
    const auth = { Authorization: `Bearer ${ownerToken}` };

    const before = await http().get('/api/v1/conversations').set(auth).expect(200);
    expect(before.body.data[0].assignedTo).toBeNull();

    const me = await http().get('/api/v1/auth/me').set(auth).expect(200);
    await http()
      .post(`/api/v1/conversations/${refId}/assign`)
      .set(auth)
      .send({ employeeRefId: me.body.data.employeeRefId })
      .expect(204);

    const after = await http().get('/api/v1/conversations').set(auth).expect(200);
    expect(after.body.data[0].assignedTo).toEqual({
      refId: me.body.data.employeeRefId,
      name: 'Meera Iyer',
    });

    // The filter this makes work at all: it was permanently empty before,
    // because nothing ever read the column back.
    const mine = await http().get('/api/v1/conversations?assignedToMe=true').set(auth).expect(200);
    expect(mine.body.data).toHaveLength(1);
  });

  it('unassigns', async () => {
    const { ownerToken, enterpriseRefId } = await onboardedBusiness();
    const refId = await seedConversation(enterpriseRefId);
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const me = await http().get('/api/v1/auth/me').set(auth).expect(200);

    await http()
      .post(`/api/v1/conversations/${refId}/assign`)
      .set(auth)
      .send({ employeeRefId: me.body.data.employeeRefId })
      .expect(204);
    await http()
      .post(`/api/v1/conversations/${refId}/assign`)
      .set(auth)
      .send({ employeeRefId: null })
      .expect(204);

    const after = await http().get('/api/v1/conversations').set(auth).expect(200);
    expect(after.body.data[0].assignedTo).toBeNull();
  });

  it('refuses to assign work to somebody from another business', async () => {
    const { ownerToken, enterpriseRefId } = await onboardedBusiness();
    const refId = await seedConversation(enterpriseRefId);

    await http()
      .post(`/api/v1/conversations/${refId}/assign`)
      .set('Authorization', `Bearer ${ownerToken}`)
      // A well-formed ref that belongs to nobody here.
      .send({ employeeRefId: '11111111-2222-4333-8444-555555555555' })
      .expect(404);
  });

  it('RESOLVES a conversation — the request that used to answer 500', async () => {
    const { ownerToken, enterpriseRefId } = await onboardedBusiness();
    const refId = await seedConversation(enterpriseRefId);
    const auth = { Authorization: `Bearer ${ownerToken}` };

    await http()
      .post(`/api/v1/conversations/${refId}/status`)
      .set(auth)
      .send({ status: 'resolved' })
      .expect(204);

    const thread = await http().get(`/api/v1/conversations/${refId}`).set(auth).expect(200);
    expect(thread.body.data.conversation.status).toBe('resolved');
  });

  it('refuses a status that is not a status', async () => {
    const { ownerToken, enterpriseRefId } = await onboardedBusiness();
    const refId = await seedConversation(enterpriseRefId);

    await http()
      .post(`/api/v1/conversations/${refId}/status`)
      .set('Authorization', `Bearer ${ownerToken}`)
      // 422, this service's shape for a body that parsed but does not validate.
      .send({ status: 'nearly-done' })
      .expect(422);
  });

  it('paginates a thread, and says when there is more', async () => {
    const { ownerToken, enterpriseRefId } = await onboardedBusiness();
    const refId = await seedConversation(enterpriseRefId);
    const auth = { Authorization: `Bearer ${ownerToken}` };

    const first = await http().get(`/api/v1/conversations/${refId}?limit=1`).set(auth).expect(200);

    // One message seeded, so there is nothing after it — but the surface has to
    // exist and be honest, which it did not before: a long thread simply
    // stopped, with nothing to say there was more.
    expect(first.body.data.messages).toHaveLength(1);
    expect(first.body.data.pagination).toEqual({ nextCursor: null, hasMore: false });
  });

  it('never lets one business read another’s conversation', async () => {
    const { enterpriseRefId } = await onboardedBusiness();
    const refId = await seedConversation(enterpriseRefId);

    // A second business, whose owner must not see the first one's thread.
    const other = await http()
      .post('/api/v1/enterprises/signup')
      .send({
        business: { name: 'Rival Roasters', email: 'hello@rival.test', city: 'Pune' },
        owner: {
          firstName: 'Ada',
          lastName: 'Byron',
          email: 'ada@rival.test',
          password: OWNER_PASSWORD,
        },
      })
      .expect(201);
    const rival = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId: other.body.data.verificationRefId, code: code() })
      .expect(200);

    const admin = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
    const adminAuth = { Authorization: `Bearer ${admin.body.data.accessToken as string}` };
    await http()
      .post(`/api/v1/platform/enterprises/${other.body.data.enterpriseRefId}/status`)
      .set(adminAuth)
      .send({ status: 'active' })
      .expect(200);
    await http()
      .post(
        `/api/v1/platform/enterprises/${other.body.data.enterpriseRefId}/features/unified_inbox`,
      )
      .set(adminAuth)
      .send({ status: 'active' })
      .expect(200);

    // 404, not 403: a 403 would confirm the ref exists.
    await http()
      .get(`/api/v1/conversations/${refId}`)
      .set('Authorization', `Bearer ${rival.body.data.accessToken as string}`)
      .expect(404);
    await http()
      .post(`/api/v1/conversations/${refId}/status`)
      .set('Authorization', `Bearer ${rival.body.data.accessToken as string}`)
      .send({ status: 'closed' })
      .expect(404);
  });
});
