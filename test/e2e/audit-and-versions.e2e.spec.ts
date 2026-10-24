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
 * The trail and the history, end to end over HTTP.
 *
 * Everything below was asserted in pieces first — the trigger refuses an
 * UPDATE, the repository counts versions — and pieces are not the claim. The
 * claim is that a real request through the real guard chain lands a row naming
 * the real actor, which is the only form of it anybody will ever rely on.
 *
 * It matters because the previous state of this system was: comments asserting
 * a database guarantee that did not exist, nine audit actions declared and
 * never written, and a role revocation recorded as a grant.
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

interface AuditRow {
  action: string;
  entity_type: string;
  actor_kind: string;
  actor_employee_id: string | null;
  changes: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

describe('the audit trail and the version history, over HTTP', () => {
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

  const audit = (where = '1=1'): Promise<AuditRow[]> =>
    db.query(
      `SELECT action, entity_type, actor_kind, actor_employee_id, changes, metadata
         FROM audit_logs WHERE ${where} ORDER BY id`,
    );

  async function ownerWithRewards(): Promise<{ auth: { Authorization: string } }> {
    const signup = await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);
    const verified = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId: signup.body.data.verificationRefId, code: code() })
      .expect(200);

    const admin = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
    const adminAuth = { Authorization: `Bearer ${admin.body.data.accessToken as string}` };
    const enterpriseRefId = signup.body.data.enterpriseRefId as string;

    await http()
      .post(`/api/v1/platform/enterprises/${enterpriseRefId}/status`)
      .set(adminAuth)
      .send({ status: 'active' })
      .expect(200);
    await http()
      .post(`/api/v1/platform/enterprises/${enterpriseRefId}/features/reward_programs`)
      .set(adminAuth)
      .send({ status: 'active' })
      .expect(200);

    return { auth: { Authorization: `Bearer ${verified.body.data.accessToken as string}` } };
  }

  /**
   * A tenant coming into existence was not recorded at all. The actor is
   * `system` and that is accurate rather than a shortcut: the person signing up
   * has no account yet, which is the point of signing up.
   */
  it('records a signup, attributed to the system because there is no session yet', async () => {
    await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);

    const rows = await audit(`entity_type = 'enterprise' AND action = 'created'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_kind).toBe('system');
    expect(rows[0]?.changes).toEqual({ status: { from: null, to: 'pending_activation' } });
    /* The owner's email and name are PII and must never reach the trail. */
    expect(JSON.stringify(rows[0])).not.toContain('priya@acme.test');
  });

  /**
   * The trail had exits and no entrances: `logout` was recorded and `login`
   * never was, so it could show a session ending that it had no record of
   * beginning.
   */
  it('records a successful sign-in', async () => {
    await ownerWithRewards();

    const rows = await audit(`action = 'login'`);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.entity_type).toBe('identity');
  });

  it('records a failed sign-in without recording the credential that was tried', async () => {
    await http()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@acme.test', password: 'wrong-but-long-enough' })
      .expect(401);

    const rows = await audit(`action = 'login_failed'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata?.reason).toBe('no_such_credential');
    /* THE POINT: an unauthenticated caller must not be able to write a real
     * person's address into the audit trail by guessing at it. */
    expect(JSON.stringify(rows[0])).not.toContain('nobody@acme.test');
  });

  /**
   * The whole chain for a reward program: the audit row says who, the version
   * row says what it then was.
   */
  it('records a program creation against the employee, and opens its history at version 1', async () => {
    const { auth } = await ownerWithRewards();

    await http()
      .post('/api/v1/rewards/programs')
      .set(auth)
      .send({ name: 'Monsoon', timezone: 'Asia/Kolkata', defaultCurrencyCode: 'INR' })
      .expect(201);

    const rows = await audit(`entity_type = 'reward_program'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('created');
    /* A REAL PERSON, through the real guard chain — not the system fallback. */
    expect(rows[0]?.actor_kind).toBe('employee');
    expect(rows[0]?.actor_employee_id).not.toBeNull();

    const versions: { version: number; snapshot: Record<string, unknown> }[] = await db.query(
      `SELECT version, snapshot FROM entity_versions
        WHERE entity_type = 'reward_program' ORDER BY version`,
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
    expect(versions[0]?.snapshot).toMatchObject({ name: 'Monsoon', status: 'draft' });
  });

  /**
   * THE QUESTION THE AUDIT LOG CANNOT ANSWER. Each version carries the WHOLE
   * configuration, so "what was this on the day that award was made" is one row
   * rather than a replay of every diff since creation.
   */
  it('appends a full snapshot on every change, and serves the history newest first', async () => {
    const { auth } = await ownerWithRewards();

    const created = await http()
      .post('/api/v1/rewards/programs')
      .set(auth)
      .send({ name: 'Monsoon', timezone: 'Asia/Kolkata', defaultCurrencyCode: 'INR' })
      .expect(201);
    const refId = created.body.data.refId as string;

    await http()
      .patch(`/api/v1/rewards/programs/${refId}/status`)
      .set(auth)
      .send({ status: 'active' })
      .expect(200);
    await http()
      .patch(`/api/v1/rewards/programs/${refId}/status`)
      .set(auth)
      .send({ status: 'archived' })
      .expect(200);

    const history = await http()
      .get(`/api/v1/rewards/programs/${refId}/versions`)
      .set(auth)
      .expect(200);

    const items = history.body.data.items as {
      version: number;
      snapshot: Record<string, unknown>;
      changed: Record<string, unknown>;
      actorKind: string;
    }[];

    expect(items.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(items.map((v) => v.snapshot.status)).toEqual(['archived', 'active', 'draft']);

    /* Each snapshot stands alone — the name is on every one, not only the first. */
    for (const item of items) expect(item.snapshot.name).toBe('Monsoon');

    /* The diff is derived from the snapshots, never described by the call site. */
    expect(items[0]?.changed).toEqual({ status: { from: 'active', to: 'archived' } });
    expect(items[2]?.changed).toEqual({});
    expect(items[0]?.actorKind).toBe('employee');
  });

  /** A version history is addressed by an id that never leaves the server. */
  it('refuses a history read for a program that is not this tenant’s', async () => {
    const { auth } = await ownerWithRewards();
    await http()
      .get('/api/v1/rewards/programs/3f2a9c14-0000-4000-8000-000000000000/versions')
      .set(auth)
      .expect(404);
  });

  /**
   * The forwarding credential reference must never enter an append-only table,
   * because nothing could ever take it back out.
   */
  it('never writes the forwarding config into a snapshot', async () => {
    const { auth } = await ownerWithRewards();
    await http()
      .post('/api/v1/rewards/programs')
      .set(auth)
      .send({ name: 'Monsoon', timezone: 'Asia/Kolkata', defaultCurrencyCode: 'INR' })
      .expect(201);

    const rows: { snapshot: Record<string, unknown> }[] = await db.query(
      `SELECT snapshot FROM entity_versions WHERE entity_type = 'reward_program'`,
    );
    for (const row of rows) {
      expect(row.snapshot).not.toHaveProperty('forwardConfig');
      expect(row.snapshot).not.toHaveProperty('forward_config');
    }
  });
});
