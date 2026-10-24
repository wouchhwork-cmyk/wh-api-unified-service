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
 * Adjusting a balance by hand — the one reward action with a person behind it,
 * and the one that moves value without a rule deciding to.
 *
 * WHY THE IDEMPOTENCY TESTS ARE THE POINT OF THIS FILE. `reward_ledger_entries`
 * has a unique index on `(enterprise_id, idempotency_key)` that makes a repeat
 * a no-op — and this path used to defeat it by generating a fresh random key
 * on every call, so the index could never fire. A double-clicked button, a
 * client retrying a timeout, or a proxy replaying a request each credited the
 * customer again, silently, with real value.
 */
const OWNER_PASSWORD = 'a-long-enough-password';
const SIGNUP = {
  business: { name: 'Acme Coffee', email: 'hello@acme.test', city: 'Pune' },
  owner: {
    firstName: 'Priya',
    lastName: 'Rao',
    email: 'priya@acme.test',
    password: OWNER_PASSWORD,
  },
};

describe('adjusting a balance by hand', () => {
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

  async function business(): Promise<{ auth: { Authorization: string }; customerRefId: string }> {
    const signup = await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);
    const verified = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId: signup.body.data.verificationRefId, code: code() })
      .expect(200);

    const admin = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
    const adminAuth = { Authorization: `Bearer ${admin.body.data.accessToken as string}` };
    const refId = signup.body.data.enterpriseRefId as string;

    await http()
      .post(`/api/v1/platform/enterprises/${refId}/status`)
      .set(adminAuth)
      .send({ status: 'active' })
      .expect(200);
    await http()
      .post(`/api/v1/platform/enterprises/${refId}/features/reward_programs`)
      .set(adminAuth)
      .send({ status: 'active' })
      .expect(200);

    const auth = { Authorization: `Bearer ${verified.body.data.accessToken as string}` };

    const [enterprise] = await db.query(`SELECT id FROM enterprises WHERE ref_id = $1`, [refId]);
    const [customer] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source)
       VALUES ($1, 'Asha', 'manual') RETURNING ref_id`,
      [enterprise.id],
    );
    return { auth, customerRefId: customer.ref_id as string };
  }

  const body = (customerRefId: string, key: string, amount = 50) => ({
    customerRefId,
    walletKind: 'points',
    currencyCode: null,
    amount,
    reason: 'Goodwill after a wrong order',
    idempotencyKey: key,
  });

  const pointsBalance = async (): Promise<number> => {
    const [row] = await db.query(
      `SELECT coalesce(balance, 0)::int AS balance FROM reward_wallets WHERE wallet_kind = 'points'`,
    );
    return row ? (row.balance as number) : 0;
  };

  /* ------------------------------------------------------------------ */

  it('credits the customer once', async () => {
    const { auth, customerRefId } = await business();
    await http()
      .post('/api/v1/rewards/adjustments')
      .set(auth)
      .send(body(customerRefId, 'intent-1'))
      .expect(201);

    expect(await pointsBalance()).toBe(50);
  });

  /*
   * THE ONE THAT MATTERS. Same intent, sent twice — a retried timeout, a
   * double-click that outlived the disabled button, a proxy replay.
   */
  it('credits once however many times the same intent is sent', async () => {
    const { auth, customerRefId } = await business();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await http()
        .post('/api/v1/rewards/adjustments')
        .set(auth)
        .send(body(customerRefId, 'intent-1'));
    }

    expect(await pointsBalance()).toBe(50);
    const [entries] = await db.query(
      `SELECT count(*)::int AS n FROM reward_ledger_entries WHERE entry_kind = 'adjust'`,
    );
    expect(entries.n).toBe(1);
  });

  /*
   * AND THE CASE THAT MUST STILL WORK, which is why the key is supplied by the
   * caller rather than derived from the payload: the same employee crediting
   * the same customer the same amount twice, on purpose.
   */
  it('credits twice for two genuinely different intents', async () => {
    const { auth, customerRefId } = await business();

    await http()
      .post('/api/v1/rewards/adjustments')
      .set(auth)
      .send(body(customerRefId, 'intent-1'))
      .expect(201);
    await http()
      .post('/api/v1/rewards/adjustments')
      .set(auth)
      .send(body(customerRefId, 'intent-2'))
      .expect(201);

    expect(await pointsBalance()).toBe(100);
  });

  it('refuses a request with no idempotency key rather than inventing one', async () => {
    const { auth, customerRefId } = await business();
    const sent = body(customerRefId, 'unused') as Record<string, unknown>;
    delete sent.idempotencyKey;

    await http().post('/api/v1/rewards/adjustments').set(auth).send(sent).expect(422);
    expect(await pointsBalance()).toBe(0);
  });

  it('refuses a key too short to be a real one', async () => {
    const { auth, customerRefId } = await business();
    await http()
      .post('/api/v1/rewards/adjustments')
      .set(auth)
      .send(body(customerRefId, 'abc'))
      .expect(422);
  });
});
