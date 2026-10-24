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
import { ErrorCode } from '@/shared/errors/error-codes.enum';

/**
 * Rewards behind the commercial switch, over HTTP.
 *
 * Two gates guard every endpoint and they are NOT the same gate. Gate 2 is the
 * role: does this employee hold `rewards.view`. Gate 1 is commercial: has a
 * platform admin switched `reward_programs` on for this business at all.
 *
 * Rewards shipped with gate 2 only, which meant any owner could reach a feature
 * nobody had sold them — and the admin console had nothing to toggle, because
 * the permission pointed at no feature. The owner below holds the permission
 * throughout; the only thing that changes between the two assertions is the
 * switch.
 *
 * It is also the first HTTP coverage these routes have had.
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

describe('reward programs behind the feature switch', () => {
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

  async function onboardedBusiness(): Promise<{
    ownerToken: string;
    enterpriseRefId: string;
    adminAuth: { Authorization: string };
  }> {
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

    return {
      ownerToken: verified.body.data.accessToken as string,
      enterpriseRefId: signup.body.data.enterpriseRefId as string,
      adminAuth,
    };
  }

  /**
   * Invites somebody into a role and returns their accepted token.
   *
   * Needed for the gate-2 counterpart below: the owner holds every rewards
   * permission, so only a colleague who holds none can prove that a refusal
   * about the ROLE still reads as one.
   */
  async function member(
    ownerToken: string,
    firstName: string,
    email: string,
    roleName: string,
  ): Promise<string> {
    const bearer = { Authorization: `Bearer ${ownerToken}` };
    const roles = await http().get('/api/v1/roles').set(bearer).expect(200);
    const role = (roles.body.data as { refId: string; name: string }[]).find(
      (r) => r.name === roleName,
    );
    if (!role) throw new Error(`role ${roleName} not found`);

    await http()
      .post('/api/v1/employees')
      .set(bearer)
      .send({ firstName, email, roleRefId: role.refId })
      .expect(201);

    const accepted = await http()
      .post('/api/v1/auth/accept-invite')
      .send({ email, code: code(), password: OWNER_PASSWORD })
      .expect(200);

    return accepted.body.data.accessToken as string;
  }

  const grantRewards = (enterpriseRefId: string, adminAuth: { Authorization: string }) =>
    http()
      .post(`/api/v1/platform/enterprises/${enterpriseRefId}/features/reward_programs`)
      .set(adminAuth)
      .send({ status: 'active' })
      .expect(200);

  /**
   * THE ASSERTION THE WHOLE CHANGE EXISTS FOR.
   *
   * The owner holds `rewards.view` — the seed grants it to the owner template —
   * so a 403 here can only come from gate 1.
   *
   * AND IT NOW SAYS SO. This asserted `PERMISSION_DENIED`, which was the
   * truthful code at the time and told the owner nothing they could act on:
   * the two gates were indistinguishable, so the portal could not tell them
   * whether to ask for a role or ask an admin to switch the feature on.
   * `FEATURE_NOT_ENABLED` existed for this and nothing threw it.
   */
  it('refuses an owner whose business has not been given the feature', async () => {
    const { ownerToken } = await onboardedBusiness();

    const refused = await http()
      .get('/api/v1/rewards/programs')
      .set({ Authorization: `Bearer ${ownerToken}` })
      .expect(403);

    expect(refused.body.error.code).toBe(ErrorCode.FeatureNotEnabled);
    /* Which feature, so the client can name it. */
    expect(refused.body.error.details).toEqual([{ field: 'feature', issue: 'reward_programs' }]);
  });

  /**
   * THE OTHER HALF, and the reason the distinction is worth having: a refusal
   * that is genuinely about the ROLE must still say `PERMISSION_DENIED`, or the
   * new code would just be a rename.
   *
   * An agent works the inbox and cannot change configuration, so it holds
   * `rewards.view` — every role gets the view action — and NOT
   * `rewards.manage`. With the feature switched ON, creating a program is
   * refused by gate 2 alone.
   */
  it('still says permission denied when the feature is on and the role is not', async () => {
    const { enterpriseRefId, adminAuth, ownerToken } = await onboardedBusiness();
    await grantRewards(enterpriseRefId, adminAuth);

    const agent = await member(ownerToken, 'Rahul', 'rahul@acme.test', 'agent');
    const agentAuth = { Authorization: `Bearer ${agent}` };

    /* Gate 1 is open for them — they can read. */
    await http().get('/api/v1/rewards/programs').set(agentAuth).expect(200);

    const refused = await http()
      .post('/api/v1/rewards/programs')
      .set(agentAuth)
      .send({ name: 'Monsoon', timezone: 'Asia/Kolkata' })
      .expect(403);

    /* So the only thing left to refuse them is the role. */
    expect(refused.body.error.code).toBe(ErrorCode.PermissionDenied);
  });

  it('lets the same owner in once a platform admin switches it on', async () => {
    const { ownerToken, enterpriseRefId, adminAuth } = await onboardedBusiness();
    const ownerAuth = { Authorization: `Bearer ${ownerToken}` };

    await http().get('/api/v1/rewards/programs').set(ownerAuth).expect(403);

    await grantRewards(enterpriseRefId, adminAuth);

    const allowed = await http().get('/api/v1/rewards/programs').set(ownerAuth).expect(200);
    expect(allowed.body.data.items).toEqual([]);
  });

  /** The dashboard rides the same permission, so it rides the same switch. */
  it('gates the dashboard on the same feature', async () => {
    const { ownerToken, enterpriseRefId, adminAuth } = await onboardedBusiness();
    const ownerAuth = { Authorization: `Bearer ${ownerToken}` };

    await http().get('/api/v1/rewards/dashboard').set(ownerAuth).expect(403);

    await grantRewards(enterpriseRefId, adminAuth);

    const allowed = await http().get('/api/v1/rewards/dashboard').set(ownerAuth).expect(200);
    expect(allowed.body.data.items).toEqual([]);
  });

  /**
   * The feature switches OFF again.
   *
   * A business that stops paying keeps its ledger — the rows are a liability,
   * not a licence — but loses the endpoints. Revocation going one way only is
   * how a cancelled account keeps working for ever.
   */
  it('shuts the door again when the feature is revoked', async () => {
    const { ownerToken, enterpriseRefId, adminAuth } = await onboardedBusiness();
    const ownerAuth = { Authorization: `Bearer ${ownerToken}` };

    await grantRewards(enterpriseRefId, adminAuth);
    await http().get('/api/v1/rewards/programs').set(ownerAuth).expect(200);

    await http()
      .post(`/api/v1/platform/enterprises/${enterpriseRefId}/features/reward_programs`)
      .set(adminAuth)
      /* A reason is required to revoke — the contract refuses it otherwise. */
      .send({ status: 'revoked', reason: 'plan cancelled' })
      .expect(200);

    const refused = await http().get('/api/v1/rewards/programs').set(ownerAuth).expect(403);

    /* Revoked is not active, so gate 1 closes again and names itself. */
    expect(refused.body.error.code).toBe(ErrorCode.FeatureNotEnabled);
  });
});
