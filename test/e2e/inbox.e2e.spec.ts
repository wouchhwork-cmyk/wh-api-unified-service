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

    /*
     * Every surface here is feature-gated, and the gate is real: without these
     * every request below is a 403 rather than a failure of what is under test.
     * That the gate itself works is asserted in the platform-console suite.
     */
    for (const feature of ['unified_inbox', 'post_insights', 'customer_directory']) {
      await http()
        .post(
          `/api/v1/platform/enterprises/${signup.body.data.enterpriseRefId}/features/${feature}`,
        )
        .set(adminAuth)
        .send({ status: 'active' })
        .expect(200);
    }

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

  it('answers a malformed reference with 422, not 500', async () => {
    const { ownerToken } = await onboardedBusiness();
    const auth = { Authorization: `Bearer ${ownerToken}` };

    /*
     * ref_id is a `uuid` column, so an unvalidated path segment reached Postgres
     * and came back as 22P02 — a 500 on input the caller controls. The schema to
     * prevent that already existed and was applied on the platform and employee
     * routes but not here.
     */
    await http().get('/api/v1/conversations/not-a-uuid').set(auth).expect(422);
    await http().post('/api/v1/conversations/not-a-uuid/read').set(auth).expect(422);
    await http()
      .post('/api/v1/conversations/not-a-uuid/status')
      .set(auth)
      .send({ status: 'open' })
      .expect(422);
    await http().get('/api/v1/posts?channelRefId=not-a-uuid').set(auth).expect(422);
  });

  it('restarts a listing from the top when the cursor is nonsense', async () => {
    const { ownerToken, enterpriseRefId } = await onboardedBusiness();
    await seedConversation(enterpriseRefId);
    const auth = { Authorization: `Bearer ${ownerToken}` };

    // The cursor is OPAQUE: clients must not build one, so there is nothing
    // useful to tell them about a bad one. It must not be a 500 either — the
    // three hand-rolled decoders it replaced all bound an Invalid Date into the
    // query.
    const garbage = await http().get('/api/v1/conversations?cursor=garbage').set(auth).expect(200);
    expect(garbage.body.data).toHaveLength(1);

    const badDate = Buffer.from('{"t":"nope","i":1}').toString('base64url');
    await http().get(`/api/v1/customers?cursor=${badDate}`).set(auth).expect(200);
  });

  it('returns a thread without a single internal id', async () => {
    const { ownerToken, enterpriseRefId } = await onboardedBusiness();
    const refId = await seedConversation(enterpriseRefId);

    const thread = await http()
      .get(`/api/v1/conversations/${refId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    // It used to return the row as it came out of the database: id, customerId
    // and sentByEmployeeId, all internal bigints — the one thing this API's own
    // platform-console test asserts it never does.
    const message = thread.body.data.messages[0];
    expect(Object.keys(message).sort()).toEqual([
      'body',
      'createdAt',
      'direction',
      'isInternalNote',
      'isRead',
      'messageKind',
      'platformSentAt',
      'refId',
      'sentBy',
      'status',
    ]);
  });

  it('names the colleague who sent a reply', async () => {
    const { ownerToken, enterpriseRefId } = await onboardedBusiness();
    const refId = await seedConversation(enterpriseRefId);
    const auth = { Authorization: `Bearer ${ownerToken}` };

    await http()
      .post(`/api/v1/conversations/${refId}/reply`)
      .set(auth)
      .send({ body: 'we open at nine', internalNote: true, idempotencyKey: 'note-one-key' })
      .expect(202);

    const thread = await http().get(`/api/v1/conversations/${refId}`).set(auth).expect(200);
    const note = thread.body.data.messages.find(
      (m: { isInternalNote: boolean }) => m.isInternalNote,
    );
    // A name, not an id: a client cannot turn an employee id into anything.
    expect(note.sentBy).toEqual({ refId: expect.any(String), name: 'Meera Iyer' });
  });

  it('refuses a reply with no idempotency key at all', async () => {
    const { ownerToken, enterpriseRefId } = await onboardedBusiness();
    const refId = await seedConversation(enterpriseRefId);

    // The one write that reaches a customer had no idempotency unless the caller
    // opted in, which is exactly backwards.
    await http()
      .post(`/api/v1/conversations/${refId}/reply`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ body: 'hello', internalNote: true })
      .expect(422);
  });

  it('refuses a key already used for a different message', async () => {
    const { ownerToken, enterpriseRefId } = await onboardedBusiness();
    const refId = await seedConversation(enterpriseRefId);
    const auth = { Authorization: `Bearer ${ownerToken}` };

    await http()
      .post(`/api/v1/conversations/${refId}/reply`)
      .set(auth)
      .send({ body: 'first', internalNote: true, idempotencyKey: 'shared-key-x' })
      .expect(202);

    /*
     * Same key, different request. It used to return the FIRST message with a
     * 202: the caller was told its second reply was accepted, the reply was
     * never written, and nothing recorded that a customer had been left
     * unanswered.
     */
    const conflict = await http()
      .post(`/api/v1/conversations/${refId}/reply`)
      .set(auth)
      .send({ body: 'second', internalNote: false, idempotencyKey: 'shared-key-x' })
      .expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('returns the original message when the SAME request is retried', async () => {
    const { ownerToken, enterpriseRefId } = await onboardedBusiness();
    const refId = await seedConversation(enterpriseRefId);
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const body = { body: 'once', internalNote: true, idempotencyKey: 'retry-key-xx' };

    const first = await http()
      .post(`/api/v1/conversations/${refId}/reply`)
      .set(auth)
      .send(body)
      .expect(202);
    const again = await http()
      .post(`/api/v1/conversations/${refId}/reply`)
      .set(auth)
      .send(body)
      .expect(202);

    expect(again.body.data.messageRefId).toBe(first.body.data.messageRefId);
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

    const rivalAuth = { Authorization: `Bearer ${rival.body.data.accessToken as string}` };

    /*
     * PROVE THE GATE IS OPEN FIRST.
     *
     * Both assertions below are 404s, and a 403 from the feature gate would fail
     * them for a reason that has nothing to do with tenancy — which is exactly
     * how a fixture problem reads as an intermittent tenancy failure. This line
     * makes the two distinguishable: if the rival cannot reach its own empty
     * inbox, the fixture is wrong, and it says so here rather than 20 lines down.
     */
    const ownInbox = await http().get('/api/v1/conversations').set(rivalAuth).expect(200);
    expect(ownInbox.body.data).toEqual([]);

    // 404, not 403: a 403 would confirm the ref exists.
    await http().get(`/api/v1/conversations/${refId}`).set(rivalAuth).expect(404);
    await http()
      .post(`/api/v1/conversations/${refId}/status`)
      .set(rivalAuth)
      .send({ status: 'closed' })
      .expect(404);
  });
});
