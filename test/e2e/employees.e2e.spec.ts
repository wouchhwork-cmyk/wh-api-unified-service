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

describe('a business builds its team', () => {
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

  /** Signs up, verifies, and gets the business activated. */
  async function onboardedBusiness(): Promise<{ ownerToken: string; enterpriseRefId: string }> {
    const signup = await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);
    const verified = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId: signup.body.data.verificationRefId, code: code() })
      .expect(200);

    const admin = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
    await http()
      .post(`/api/v1/platform/enterprises/${signup.body.data.enterpriseRefId}/status`)
      .set('Authorization', `Bearer ${admin.body.data.accessToken}`)
      .send({ status: 'active' })
      .expect(200);

    return {
      ownerToken: verified.body.data.accessToken as string,
      enterpriseRefId: signup.body.data.enterpriseRefId as string,
    };
  }

  async function roleRefId(ownerToken: string, name: string): Promise<string> {
    const roles = await http()
      .get('/api/v1/employees/roles')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const match = (roles.body.data as { refId: string; name: string }[]).find(
      (role) => role.name === name,
    );
    if (!match) throw new Error(`role ${name} was not instantiated for this business`);
    return match.refId;
  }

  it('refuses a second signup for the same business', async () => {
    await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);

    // A colleague signing up the same business must be turned away and told what
    // to do instead — otherwise two people get two separate tenants with the
    // same name, split data, and a product that looks broken.
    const second = await http()
      .post('/api/v1/enterprises/signup')
      .send({
        business: { name: 'Blue Bottle Cafe Pune', email: SIGNUP.business.email },
        owner: { firstName: 'Rahul', email: 'rahul@bluebottle.test', password: OWNER_PASSWORD },
      })
      .expect(409);

    expect(second.body.error.code).toBe('ENTERPRISE_EMAIL_ALREADY_REGISTERED');
    expect(second.body.error.message).toMatch(/ask its owner/i);
  });

  it('is case-insensitive about the business address', async () => {
    await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);
    await http()
      .post('/api/v1/enterprises/signup')
      .send({
        business: { name: 'Other', email: SIGNUP.business.email.toUpperCase() },
        owner: { firstName: 'Rahul', email: 'rahul@bluebottle.test', password: OWNER_PASSWORD },
      })
      .expect(409);
  });

  it('creates a colleague without ever accepting a password for them', async () => {
    const { ownerToken } = await onboardedBusiness();
    const agentRole = await roleRefId(ownerToken, 'agent');

    const created = await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        firstName: 'Rahul',
        lastName: 'Nair',
        email: 'rahul@bluebottle.test',
        roleRefId: agentRole,
      })
      .expect(201);

    expect(created.body.data.status).toBe('invited');
    expect(created.body.data.employeeKind).toBe('business');
    expect(created.body.data.roles).toEqual(['agent']);
    // Masked even to the colleague who typed it.
    expect(created.body.data.email).toBe('ra***@bluebottle.test');

    // A password field is not merely optional — it is refused, so nobody can
    // set a colleague's credential by adding one to the request.
    await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        firstName: 'Anita',
        email: 'anita@bluebottle.test',
        roleRefId: agentRole,
        password: 'set-by-the-owner',
      })
      .expect(422);
  });

  it('will not let the invited person sign in until they accept', async () => {
    const { ownerToken } = await onboardedBusiness();
    const agentRole = await roleRefId(ownerToken, 'agent');

    await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ firstName: 'Rahul', email: 'rahul@bluebottle.test', roleRefId: agentRole })
      .expect(201);

    // The stored password is random and nobody was told it.
    const attempt = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'rahul@bluebottle.test', password: 'a-guess-at-the-password' })
      .expect(401);
    expect(attempt.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('lets the invited person prove the address and choose their own password', async () => {
    const { ownerToken } = await onboardedBusiness();
    const agentRole = await roleRefId(ownerToken, 'agent');

    await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ firstName: 'Rahul', email: 'rahul@bluebottle.test', roleRefId: agentRole })
      .expect(201);

    // Keyed on their OWN address, not a verification reference: they were never
    // shown one — the owner made that request, on another device.
    const accepted = await http()
      .post('/api/v1/auth/accept-invite')
      .send({
        email: 'rahul@bluebottle.test',
        code: code(),
        password: 'a-password-only-rahul-knows',
      })
      .expect(200);

    expect(accepted.body.data.outcome).toBe('authenticated');
    expect(accepted.body.data.enterprise.name).toBe('Blue Bottle Cafe');

    // And from now on, an ordinary login.
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'rahul@bluebottle.test', password: 'a-password-only-rahul-knows' })
      .expect(200);
    expect(login.body.data.outcome).toBe('authenticated');

    // The employment moved invited -> active on acceptance, not before.
    const team = await http()
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const rahul = (team.body.data as { name: string; status: string }[]).find(
      (person) => person.name === 'Rahul',
    );
    expect(rahul?.status).toBe('active');
  });

  it('refuses the same code twice, and a wrong one', async () => {
    const { ownerToken } = await onboardedBusiness();
    const agentRole = await roleRefId(ownerToken, 'agent');
    await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ firstName: 'Rahul', email: 'rahul@bluebottle.test', roleRefId: agentRole })
      .expect(201);

    const wrong = await http()
      .post('/api/v1/auth/accept-invite')
      .send({ email: 'rahul@bluebottle.test', code: '000001', password: 'a-long-enough-password' })
      .expect(401);
    expect(wrong.body.error.code).toBe('AUTH_CODE_INVALID');

    await http()
      .post('/api/v1/auth/accept-invite')
      .send({ email: 'rahul@bluebottle.test', code: code(), password: 'a-long-enough-password' })
      .expect(200);

    // Single use: the second attempt cannot find a live challenge, and says the
    // same thing an unknown address would — whether an invitation exists is not
    // confirmed to a guesser.
    const replay = await http()
      .post('/api/v1/auth/accept-invite')
      .send({ email: 'rahul@bluebottle.test', code: code(), password: 'another-long-password' })
      .expect(404);
    expect(replay.body.error.code).toBe('VERIFICATION_NOT_FOUND');
  });

  it('gives an agent no authority to build the team', async () => {
    const { ownerToken } = await onboardedBusiness();
    const agentRole = await roleRefId(ownerToken, 'agent');
    await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ firstName: 'Rahul', email: 'rahul@bluebottle.test', roleRefId: agentRole })
      .expect(201);
    const accepted = await http()
      .post('/api/v1/auth/accept-invite')
      .send({ email: 'rahul@bluebottle.test', code: code(), password: 'a-long-enough-password' })
      .expect(200);
    const agentToken = accepted.body.data.accessToken as string;

    const refused = await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({
        firstName: 'Anita',
        email: 'anita@bluebottle.test',
        roleRefId: agentRole,
      })
      .expect(403);
    expect(refused.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('suspends somebody, and the suspension applies to a token already issued', async () => {
    const { ownerToken } = await onboardedBusiness();
    const agentRole = await roleRefId(ownerToken, 'agent');
    await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ firstName: 'Rahul', email: 'rahul@bluebottle.test', roleRefId: agentRole })
      .expect(201);
    const accepted = await http()
      .post('/api/v1/auth/accept-invite')
      .send({ email: 'rahul@bluebottle.test', code: code(), password: 'a-long-enough-password' })
      .expect(200);
    const agentToken = accepted.body.data.accessToken as string;

    const before = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(200);
    expect((before.body.data.permissions as string[]).length).toBeGreaterThan(0);

    const team = await http()
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const rahulRefId = (team.body.data as { name: string; refId: string }[]).find(
      (person) => person.name === 'Rahul',
    )?.refId;

    // A reason is required: it is the only record of why.
    const noReason = await http()
      .post(`/api/v1/employees/${rahulRefId}/status`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'suspended' })
      .expect(422);
    expect(noReason.body.error.details[0].field).toBe('reason');

    await http()
      .post(`/api/v1/employees/${rahulRefId}/status`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'suspended', reason: 'left the company' })
      .expect(200);

    /*
     * THE SAME TOKEN, which has not expired. Permissions are resolved per
     * request against the employment, so switching somebody off means now — not
     * whenever the token they are holding happens to run out.
     */
    const after = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(200);
    expect(after.body.data.permissions).toHaveLength(0);

    await http()
      .get('/api/v1/enterprises/current')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(403);

    // And they cannot sign in again.
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'rahul@bluebottle.test', password: 'a-long-enough-password' })
      .expect(403);
    expect(login.body.error.code).toBe('AUTH_NO_ACTIVE_EMPLOYMENT');
  });

  it('will not let anybody change their own status', async () => {
    const { ownerToken } = await onboardedBusiness();
    const team = await http()
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const ownRefId = (team.body.data as { refId: string }[])[0]?.refId;

    // The realistic accident: an owner locking themselves out with nobody else
    // able to undo it.
    const refused = await http()
      .post(`/api/v1/employees/${ownRefId}/status`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'suspended', reason: 'by mistake' })
      .expect(403);
    expect(refused.body.error.details[0].issue).toMatch(/your own status/i);
  });

  it('refuses to create the same person twice', async () => {
    const { ownerToken } = await onboardedBusiness();
    const agentRole = await roleRefId(ownerToken, 'agent');
    const body = { firstName: 'Rahul', email: 'rahul@bluebottle.test', roleRefId: agentRole };

    await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body)
      .expect(201);
    const again = await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body)
      .expect(409);
    expect(again.body.error.code).toBe('EMPLOYEE_ALREADY_EXISTS');
  });

  it('refuses a role that belongs to another business', async () => {
    const first = await onboardedBusiness();
    const agentRole = await roleRefId(first.ownerToken, 'agent');

    // A second business, whose owner tries to use the first one's role refId.
    const other = await http()
      .post('/api/v1/enterprises/signup')
      .send({
        business: { name: 'Zenith Salon', email: 'hello@zenith.test' },
        owner: { firstName: 'Anita', email: 'anita@zenith.test', password: OWNER_PASSWORD },
      })
      .expect(201);
    const otherVerified = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId: other.body.data.verificationRefId, code: code() })
      .expect(200);

    const admin = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
    await http()
      .post(`/api/v1/platform/enterprises/${other.body.data.enterpriseRefId}/status`)
      .set('Authorization', `Bearer ${admin.body.data.accessToken}`)
      .send({ status: 'active' })
      .expect(200);

    // The role resolves only within the caller's own business, so this is a 404
    // rather than a cross-tenant grant.
    const refused = await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${otherVerified.body.data.accessToken}`)
      .send({ firstName: 'X', email: 'x@zenith.test', roleRefId: agentRole })
      .expect(404);
    expect(refused.body.error.code).toBe('ROLE_NOT_FOUND');
  });

  it('shows each business only its own people', async () => {
    const first = await onboardedBusiness();
    const agentRole = await roleRefId(first.ownerToken, 'agent');
    await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${first.ownerToken}`)
      .send({ firstName: 'Rahul', email: 'rahul@bluebottle.test', roleRefId: agentRole })
      .expect(201);

    const team = await http()
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${first.ownerToken}`)
      .expect(200);
    expect(team.body.data).toHaveLength(2);
    // Support people are excluded unless asked for: "who works here" is a
    // question about the business's own staff.
    expect(
      (team.body.data as { employeeKind: string }[]).every((p) => p.employeeKind === 'business'),
    ).toBe(true);
  });

  it('records team changes in the audit trail', async () => {
    const { ownerToken } = await onboardedBusiness();
    const agentRole = await roleRefId(ownerToken, 'agent');
    await http()
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ firstName: 'Rahul', email: 'rahul@bluebottle.test', roleRefId: agentRole })
      .expect(201);

    const rows: { action: string; entity_type: string; actor_employee_id: string | null }[] =
      await db.query(
        `SELECT action, entity_type, actor_employee_id
           FROM audit_logs WHERE entity_type = 'enterprise_employee' ORDER BY id`,
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('created');
    // Attributed to the person who did it, not to the system.
    expect(rows[0]?.actor_employee_id).not.toBeNull();
  });
});
