import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from '@/modules/auth/token.service';
import {
  createTestApp,
  platformAdminLogin,
  provisionPlatformAdmin,
  resetTenantData,
  type TestApp,
} from './app.harness';

const SIGNUP = {
  business: { name: 'Blue Bottle Cafe', email: 'hello@bluebottle.test', city: 'Pune' },
  owner: {
    firstName: 'Meera',
    lastName: 'Iyer',
    email: 'meera@bluebottle.test',
    password: 'a-long-enough-password',
  },
};

describe('the platform admin console', () => {
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

  /** Signs up a business and verifies it, returning the owner's token and refId. */
  async function onboardBusiness(): Promise<{ token: string; refId: string }> {
    const signup = await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);
    const verified = await http()
      .post('/api/v1/auth/verify')
      .send({
        verificationRefId: signup.body.data.verificationRefId,
        code: process.env.OTP_STATIC_CODE,
      })
      .expect(200);

    expect(verified.body.data.outcome).toBe('authenticated');
    return {
      token: verified.body.data.accessToken as string,
      refId: signup.body.data.enterpriseRefId as string,
    };
  }

  async function adminToken(): Promise<string> {
    const response = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
    // Provisioned credentials are already proven, so no code is demanded — the
    // whole point of basing the challenge on proof rather than on login count.
    expect(response.body.data.outcome).toBe('authenticated');
    // No business: a platform admin has no tenant of their own.
    expect(response.body.data.enterprise).toBeNull();
    return response.body.data.accessToken as string;
  }

  it('issues the fixed code while realtime delivery is off', async () => {
    await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);

    const rows: { secret_hash: string }[] = await db.query(
      `SELECT secret_hash FROM verifications ORDER BY id DESC LIMIT 1`,
    );

    // Proves the STORED hash is the hash of the configured constant, not merely
    // that the constant happens to be accepted: a bug that stored a random code
    // but compared loosely would pass a looser assertion.
    const expected = createHmac('sha256', process.env.VERIFICATION_HMAC_PEPPER ?? '')
      .update(process.env.OTP_STATIC_CODE ?? '')
      .digest('hex');
    expect(rows[0]?.secret_hash).toBe(expected);
  });

  it('signs in the provisioned admin with no business and no code', async () => {
    const token = await adminToken();

    const me = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(me.body.data.isPlatformAdmin).toBe(true);
    expect(me.body.data.enterprise).toBeNull();
    // Not impersonation: there is no business being acted inside of. Getting this
    // wrong would mark every platform audit row as impersonated and destroy the
    // only signal the flag exists to give.
    expect(me.body.data.isImpersonated).toBe(false);
  });

  it('refuses the platform surface to a business owner', async () => {
    const { token } = await onboardBusiness();

    for (const path of ['/api/v1/platform/overview', '/api/v1/platform/enterprises']) {
      const response = await http().get(path).set('Authorization', `Bearer ${token}`).expect(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
    }
  });

  it('refuses the platform surface with no token at all', async () => {
    const response = await http().get('/api/v1/platform/enterprises').expect(401);
    expect(response.body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('blocks a business from the portal until it is activated, then lets it in', async () => {
    const { token, refId } = await onboardBusiness();

    // A signup is NOT switched on by signing up.
    const blocked = await http()
      .get('/api/v1/enterprises/current')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(blocked.body.error.code).toBe('ENTERPRISE_PENDING_ACTIVATION');

    // The owner can still see their own account, or they could never learn why
    // they are blocked.
    const me = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.data.enterprise.status).toBe('pending_activation');

    const admin = await adminToken();
    const activated = await http()
      .post(`/api/v1/platform/enterprises/${refId}/status`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ status: 'active' })
      .expect(200);
    expect(activated.body.data).toMatchObject({ from: 'pending_activation', to: 'active' });

    // The SAME token now works: the gate is evaluated per request, so activation
    // takes effect immediately rather than at the owner's next sign-in.
    const allowed = await http()
      .get('/api/v1/enterprises/current')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(allowed.body.data.status).toBe('active');
  });

  it('suspends with a reason and blocks with its own distinct code', async () => {
    const { token, refId } = await onboardBusiness();
    const admin = await adminToken();
    const auth = { Authorization: `Bearer ${admin}` };

    await http()
      .post(`/api/v1/platform/enterprises/${refId}/status`)
      .set(auth)
      .send({ status: 'active' })
      .expect(200);

    // A suspension without a reason is refused: it is the only record of why.
    const noReason = await http()
      .post(`/api/v1/platform/enterprises/${refId}/status`)
      .set(auth)
      .send({ status: 'suspended' })
      .expect(422);
    expect(noReason.body.error.details[0].field).toBe('reason');

    await http()
      .post(`/api/v1/platform/enterprises/${refId}/status`)
      .set(auth)
      .send({ status: 'suspended', reason: 'non-payment' })
      .expect(200);

    const blocked = await http()
      .get('/api/v1/enterprises/current')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    // NOT the same code as pending: the owner is told which of the two applies.
    expect(blocked.body.error.code).toBe('ENTERPRISE_SUSPENDED');
  });

  it('refuses a transition the state machine does not allow', async () => {
    const { refId } = await onboardBusiness();
    const admin = await adminToken();
    const auth = { Authorization: `Bearer ${admin}` };

    await http()
      .post(`/api/v1/platform/enterprises/${refId}/status`)
      .set(auth)
      .send({ status: 'active' })
      .expect(200);

    const again = await http()
      .post(`/api/v1/platform/enterprises/${refId}/status`)
      .set(auth)
      .send({ status: 'active' })
      .expect(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(again.body.error.details[0].issue).toContain('already active');
  });

  it("makes a granted feature take effect on the owner's next request", async () => {
    const { token, refId } = await onboardBusiness();
    const admin = await adminToken();
    const auth = { Authorization: `Bearer ${admin}` };

    await http()
      .post(`/api/v1/platform/enterprises/${refId}/status`)
      .set(auth)
      .send({ status: 'active' })
      .expect(200);

    const before = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      (before.body.data.permissions as string[]).filter((p) => p.startsWith('conversations.')),
    ).toHaveLength(0);

    await http()
      .post(`/api/v1/platform/enterprises/${refId}/features/unified_inbox`)
      .set(auth)
      .send({ status: 'active' })
      .expect(200);

    // The same token again: permissions are resolved per request, so the two
    // gates compose without anyone signing in again.
    const after = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      (after.body.data.permissions as string[]).filter((p) => p.startsWith('conversations.')),
    ).not.toHaveLength(0);
  });

  it('refuses to disable a feature the business was never granted', async () => {
    const { refId } = await onboardBusiness();
    const admin = await adminToken();

    const response = await http()
      .post(`/api/v1/platform/enterprises/${refId}/features/post_insights`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ status: 'disabled' })
      .expect(409);
    expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('records every platform mutation against the staff actor', async () => {
    const { refId } = await onboardBusiness();
    const admin = await adminToken();
    const auth = { Authorization: `Bearer ${admin}` };

    await http()
      .post(`/api/v1/platform/enterprises/${refId}/status`)
      .set(auth)
      .send({ status: 'active' })
      .expect(200);
    await http()
      .post(`/api/v1/platform/enterprises/${refId}/features/unified_inbox`)
      .set(auth)
      .send({ status: 'active' })
      .expect(200);

    const rows: {
      action: string;
      entity_type: string;
      actor_staff_id: string | null;
      actor_kind: string;
      is_impersonated: boolean;
      changes: Record<string, unknown>;
    }[] = await db.query(
      `SELECT action, entity_type, actor_staff_id, actor_kind, is_impersonated, changes
         FROM audit_logs ORDER BY id`,
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.action}:${r.entity_type}`)).toEqual([
      'updated:enterprise',
      'feature_decided:enterprise_feature',
    ]);
    for (const row of rows) {
      expect(row.actor_kind).toBe('staff');
      expect(row.actor_staff_id).not.toBeNull();
      expect(row.is_impersonated).toBe(false);
    }
    expect(rows[0]?.changes).toEqual({
      status: { from: 'pending_activation', to: 'active' },
    });
  });

  it('lists businesses with counts and never leaks an internal id', async () => {
    const { refId } = await onboardBusiness();
    const admin = await adminToken();

    const list = await http()
      .get('/api/v1/platform/enterprises?limit=10')
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);

    expect(list.body.data).toHaveLength(1);
    const row = list.body.data[0];
    expect(row.refId).toBe(refId);
    expect(row.status).toBe('pending_activation');
    expect(row.counts.employees).toBe(1);
    expect(row.counts.customers).toBe(0);

    // The cursor is built from the internal key, which must be stripped from the
    // payload: a sequential id would tell a caller how many businesses exist.
    expect(row.internalId).toBeUndefined();
    expect(JSON.stringify(list.body.data)).not.toContain('internalId');
  });

  it('filters and searches the business list', async () => {
    await onboardBusiness();
    const admin = await adminToken();
    const auth = { Authorization: `Bearer ${admin}` };

    const pending = await http()
      .get('/api/v1/platform/enterprises?status=pending_activation')
      .set(auth)
      .expect(200);
    expect(pending.body.data).toHaveLength(1);

    const active = await http()
      .get('/api/v1/platform/enterprises?status=active')
      .set(auth)
      .expect(200);
    expect(active.body.data).toHaveLength(0);

    const hit = await http()
      .get('/api/v1/platform/enterprises?search=bluebottle')
      .set(auth)
      .expect(200);
    expect(hit.body.data).toHaveLength(1);

    const miss = await http()
      .get('/api/v1/platform/enterprises?search=nothing-like-this')
      .set(auth)
      .expect(200);
    expect(miss.body.data).toHaveLength(0);
  });

  it('rejects an unknown feature key and a malformed business reference', async () => {
    const { refId } = await onboardBusiness();
    const admin = await adminToken();
    const auth = { Authorization: `Bearer ${admin}` };

    // An allowlisted enum, so an unknown key never reaches a query.
    await http()
      .post(`/api/v1/platform/enterprises/${refId}/features/not_a_feature`)
      .set(auth)
      .send({ status: 'active' })
      .expect(422);

    // A malformed uuid is a clean 422, not a Postgres 22P02 surfacing as a 500.
    const malformed = await http()
      .get('/api/v1/platform/enterprises/not-a-uuid')
      .set(auth)
      .expect(422);
    expect(malformed.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns a business that does not exist as a 404', async () => {
    const admin = await adminToken();
    const response = await http()
      .get('/api/v1/platform/enterprises/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${admin}`)
      .expect(404);
    expect(response.body.error.code).toBe('ENTERPRISE_NOT_FOUND');
  });
});

describe('access-token hygiene', () => {
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

  it('refuses a selection token presented as an access token', async () => {
    // Two identities, one person: the only way to make login return a selection
    // token rather than a session.
    const first = await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);
    await http()
      .post('/api/v1/auth/verify')
      .send({
        verificationRefId: first.body.data.verificationRefId,
        code: process.env.OTP_STATIC_CODE,
      })
      .expect(200);

    // A second business for the SAME owner credential is refused, so instead mint
    // a selection token the way login does and check the boundary directly.
    const tokens = app.get(TokenService);
    const identity: { id: string }[] = await db.query(
      `SELECT id FROM identities WHERE email = $1`,
      [SIGNUP.owner.email],
    );
    const selectionToken = await tokens.issueSelectionToken(Number(identity[0]?.id));

    // Same signing secret, valid signature, and it still must not authenticate:
    // it carries no enterpriseId, employeeId or staffId, and an absent claim is not
    // a null one.
    const response = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${selectionToken}`)
      .expect(401);
    expect(response.body.error.code).toBe('AUTH_TOKEN_INVALID');

    // It still works for what it IS for.
    const claims = await tokens.verifySelectionToken(selectionToken);
    expect(claims.purpose).toBe('enterprise_selection');
  });

  it('refuses a token whose nullable claims are absent rather than null', async () => {
    const jwt = app.get(JwtService);
    // Hand-rolled to look almost right: correct type, correct identity, but the
    // enterprise and staff claims are missing entirely.
    const forged = await jwt.signAsync(
      { typ: 'access', sub: '1', identityId: 1, actorKind: 'staff', isImpersonated: false },
      { expiresIn: 60 },
    );

    const response = await http()
      .get('/api/v1/platform/enterprises')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
    expect(response.body.error.code).toBe('AUTH_TOKEN_INVALID');
  });
});
