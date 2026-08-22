import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp, readLatestVerificationSecret, resetTenantData, type TestApp } from './app.harness';

const SIGNUP = {
  business: { name: 'Acme Coffee', email: 'hello@acmecoffee.test', city: 'Pune' },
  owner: {
    firstName: 'Priya',
    lastName: 'Sharma',
    email: 'priya@acmecoffee.test',
    password: 'a-long-enough-password',
  },
};

describe('business onboarding and sign-in', () => {
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
  });

  const http = () => request(app.getHttpServer());

  it('creates the business, the owner, and the owner role in one call', async () => {
    const response = await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);

    expect(response.body.success).toBe(true);
    expect(response.body.data.slug).toBe('acme-coffee');
    // The destination is masked even in the response that confirms it was sent.
    expect(response.body.data.maskedDestination).toBe('pr***@acmecoffee.test');
    // Only refIds cross the boundary; a numeric id never does.
    expect(response.body.data.enterpriseRefId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(response.body)).not.toContain('"id"');

    // The enterprise got its OWN copies of the role templates, because a
    // NULL-enterprise role is structurally unassignable.
    const roles = (await db.query(
      `SELECT r.name FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
        WHERE r.enterprise_id IS NOT NULL`,
    )) as { name: string }[];
    expect(roles.map((r) => r.name)).toEqual(['owner']);
  });

  it('rejects an owner with neither an email nor a mobile', async () => {
    const response = await http()
      .post('/api/v1/enterprises/signup')
      .send({ business: SIGNUP.business, owner: { firstName: 'X', password: 'a-long-password' } })
      .expect(422);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a mobile with no country, because digits alone are not a number', async () => {
    const response = await http()
      .post('/api/v1/enterprises/signup')
      .send({
        business: SIGNUP.business,
        owner: { firstName: 'X', mobile: { number: '9876543210' }, password: 'a-long-password' },
      })
      .expect(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('requires verification on first login, and issues no session until it passes', async () => {
    await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);

    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: SIGNUP.owner.email, password: SIGNUP.owner.password })
      .expect(200);

    // Verification required is a 200 with what the client needs next, not an error.
    expect(login.body.data.outcome).toBe('verification_required');
    expect(login.body.data.deliveryChannel).toBe('email');
    // The code itself is never in the response.
    expect(JSON.stringify(login.body)).not.toMatch(/\b\d{6}\b/);
    expect(login.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a wrong code, then accepts the right one exactly once', async () => {
    await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: SIGNUP.owner.email, password: SIGNUP.owner.password })
      .expect(200);
    const verificationRefId = login.body.data.verificationRefId as string;
    const code = await readLatestVerificationSecret(db);

    const wrong = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId, code: code === '000000' ? '111111' : '000000' })
      .expect(401);
    expect(wrong.body.error.code).toBe('AUTH_CODE_INVALID');

    const ok = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId, code })
      .expect(200);
    expect(ok.body.data.outcome).toBe('authenticated');
    expect(ok.body.data.enterprise.slug).toBe('acme-coffee');

    // The refresh token is an httpOnly cookie, never a body field.
    const cookies = ok.headers['set-cookie'] as unknown as string[];
    expect(cookies.join(';')).toContain('HttpOnly');
    expect(ok.body.data).not.toHaveProperty('refreshToken');

    // Single use: replaying the same code must fail.
    const replay = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId, code })
      .expect(404);
    expect(replay.body.error.code).toBe('VERIFICATION_NOT_FOUND');
  });

  it('gives the same error for an unknown account as for a wrong password', async () => {
    await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);

    const unknown = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@nowhere.test', password: 'a-long-enough-password' })
      .expect(401);
    const wrongPassword = await http()
      .post('/api/v1/auth/login')
      .send({ email: SIGNUP.owner.email, password: 'the-wrong-password' })
      .expect(401);

    // Identical code AND message: the endpoint must not be an enumeration oracle.
    expect(unknown.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(wrongPassword.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('resolves permissions per request, gated by the enterprise’s features', async () => {
    await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: SIGNUP.owner.email, password: SIGNUP.owner.password })
      .expect(200);
    const code = await readLatestVerificationSecret(db);
    const verified = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId: login.body.data.verificationRefId, code })
      .expect(200);
    const token = verified.body.data.accessToken as string;

    const before = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const gatedBefore = (before.body.data.permissions as string[]).filter((p) =>
      p.startsWith('conversations.'),
    );
    // Gate 1: the role grants these, but no feature is active, so they resolve to nothing.
    expect(gatedBefore).toEqual([]);

    await db.query(
      `INSERT INTO enterprise_features (enterprise_id, feature_id, status, enabled_at)
       SELECT (SELECT id FROM enterprises LIMIT 1), id, 'active', now()
         FROM features WHERE "key" = 'unified_inbox'`,
    );

    // The SAME token: permissions are resolved per request, so a feature change
    // applies immediately rather than at the next login.
    const after = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const gatedAfter = (after.body.data.permissions as string[]).filter((p) =>
      p.startsWith('conversations.'),
    );
    expect(gatedAfter.length).toBeGreaterThan(0);
  });

  it('refuses an unauthenticated request to a protected route', async () => {
    const response = await http().get('/api/v1/enterprises/current').expect(401);
    expect(response.body.error.code).toBe('AUTH_TOKEN_INVALID');
    // No stack, no SQL, no internal detail.
    expect(JSON.stringify(response.body)).not.toMatch(/at \w+|SELECT|node_modules/);
  });

  it('keeps liveness independent of the database', async () => {
    const response = await http().get('/api/v1/health/live').expect(200);
    expect(response.body.data.status).toBe('ok');
    // Unauthenticated: it must reveal no version, host, or dependency detail.
    expect(JSON.stringify(response.body)).not.toMatch(/version|host|postgres/i);
  });
});
