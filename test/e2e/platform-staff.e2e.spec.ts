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
 * A platform admin adding one of Wouchh's own people.
 *
 * WHY THIS SURFACE IS DELICATE. Staff sit above every tenant, there is no
 * signup route to become one, and there is no self-serve recovery if the
 * console locks itself out. So the tests that matter here are about what the
 * endpoint REFUSES: it must not adopt somebody else's identity, must not mint
 * an authority equal to its own, and must not let the last way in be closed.
 */
describe('adding one of our own people', () => {
  let testApp: TestApp;
  let app: NestExpressApplication;
  let db: DataSource;
  let admin: string;

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
    const login = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
    admin = login.body.data.accessToken as string;
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const code = (): string => process.env.OTP_STATIC_CODE ?? '666666';

  const invite = (body: Record<string, unknown>) =>
    http().post('/api/v1/platform/staff').set(auth(admin)).send(body);

  const staffRow = (refId: string) =>
    http()
      .get('/api/v1/platform/staff')
      .set(auth(admin))
      .expect(200)
      .then(
        (response) =>
          (response.body.data as { refId: string; status: string; roles: string[] }[]).find(
            (person) => person.refId === refId,
          ),
      );

  describe('creating one', () => {
    it('starts them invited, reaching nothing', async () => {
      const created = await invite({ firstName: 'Nina', email: 'nina@wouchh.test' }).expect(201);

      expect(created.body.data.status).toBe('invited');
      await expect(staffRow(created.body.data.refId as string)).resolves.toMatchObject({
        status: 'invited',
      });
    });

    it('cannot make another platform admin', async () => {
      /*
       * THE ESCALATION THIS ENDPOINT MUST NOT OFFER. A full platform admin
       * answers to nobody and is scoped to nothing; promoting somebody to one
       * stays in the deployment configuration, where it costs a deploy and
       * leaves a trail. `.strict()` on the schema is what refuses it, so the
       * field cannot be smuggled past by a client that guesses the name.
       */
      await invite({
        firstName: 'Mallory',
        email: 'mallory@wouchh.test',
        hasAllEnterpriseAccess: true,
      }).expect(422);
    });

    it('refuses an address that already belongs to somebody', async () => {
      /*
       * THE ONE THAT WOULD HURT. A tenant invite deliberately REUSES an
       * existing identity — one human, one password, however many employers.
       * Doing that here would mean typing a customer's address into this form
       * and handing that customer staff reach over every business on the
       * platform.
       */
      await http()
        .post('/api/v1/enterprises/signup')
        .send({
          business: { name: 'Acme', email: 'hello@acme.test', city: 'Pune' },
          owner: {
            firstName: 'Ann',
            lastName: 'Owner',
            email: 'ann@acme.test',
            password: 'a-long-enough-password',
          },
        })
        .expect(201);

      await invite({ firstName: 'Ann', email: 'ann@acme.test' }).expect(409);
    });

    it('refuses a role that is not a staff role', async () => {
      // An enterprise role's refId must resolve to nothing here: the options
      // are the staff-scoped templates and nothing else.
      const roles = await http().get('/api/v1/platform/staff/roles').set(auth(admin)).expect(200);
      expect((roles.body.data as unknown[]).length).toBeGreaterThan(0);

      await invite({
        firstName: 'Nina',
        email: 'nina@wouchh.test',
        roleRefIds: ['3f1b2c4d-0000-4000-8000-000000000000'],
      }).expect(404);
    });

    it('insists on a way to reach them', async () => {
      await invite({ firstName: 'Nobody' }).expect(422);
    });
  });

  describe('accepting the invitation', () => {
    it('is the only thing that makes them active', async () => {
      /*
       * The whole point of `invited`. Nothing an administrator can press stands
       * in for the person proving they control the address.
       */
      const created = await invite({ firstName: 'Nina', email: 'nina@wouchh.test' }).expect(201);
      const refId = created.body.data.refId as string;

      await http()
        .post(`/api/v1/platform/staff/${refId}/status`)
        .set(auth(admin))
        .send({ status: 'active' })
        .expect(409);

      await http()
        .post('/api/v1/auth/accept-invite')
        .send({ email: 'nina@wouchh.test', code: code(), password: 'a-long-enough-password' })
        .expect(200);

      await expect(staffRow(refId)).resolves.toMatchObject({ status: 'active' });
    });

    it('gives them a session that works', async () => {
      const created = await invite({ firstName: 'Nina', email: 'nina@wouchh.test' }).expect(201);
      const accepted = await http()
        .post('/api/v1/auth/accept-invite')
        .send({ email: 'nina@wouchh.test', code: code(), password: 'a-long-enough-password' })
        .expect(200);

      expect(accepted.body.data.accessToken).toBeTruthy();
      // Scoped staff, so the admin console itself stays shut to them.
      await http()
        .get('/api/v1/platform/staff')
        .set(auth(accepted.body.data.accessToken as string))
        .expect(403);
      expect(created.body.data.status).toBe('invited');
    });
  });

  describe('suspending and reinstating', () => {
    it('cancels an invitation without reinstating it later', async () => {
      /*
       * invited -> suspended is how an invite is withdrawn, and it must not
       * become a back door: suspended -> active on a row nobody ever accepted
       * would walk a fabricated employment into being in two allowed hops.
       */
      const created = await invite({ firstName: 'Nina', email: 'nina@wouchh.test' }).expect(201);
      const refId = created.body.data.refId as string;

      await http()
        .post(`/api/v1/platform/staff/${refId}/status`)
        .set(auth(admin))
        .send({ status: 'suspended', reason: 'sent to the wrong address' })
        .expect(201);

      await http()
        .post(`/api/v1/platform/staff/${refId}/status`)
        .set(auth(admin))
        .send({ status: 'active' })
        .expect(409);
    });

    it('will not let an admin act on themselves', async () => {
      const listed = await http().get('/api/v1/platform/staff').set(auth(admin)).expect(200);
      const me = (listed.body.data as { refId: string; hasAllEnterpriseAccess: boolean }[]).find(
        (person) => person.hasAllEnterpriseAccess,
      );

      await http()
        .post(`/api/v1/platform/staff/${me?.refId}/status`)
        .set(auth(admin))
        .send({ status: 'suspended', reason: 'locking myself out' })
        .expect(403);
    });

    it('insists on a reason for a suspension', async () => {
      const created = await invite({ firstName: 'Nina', email: 'nina@wouchh.test' }).expect(201);

      await http()
        .post(`/api/v1/platform/staff/${created.body.data.refId as string}/status`)
        .set(auth(admin))
        .send({ status: 'suspended' })
        .expect(422);
    });
  });

  it('is shut to everybody who is not a platform admin', async () => {
    const signup = await http()
      .post('/api/v1/enterprises/signup')
      .send({
        business: { name: 'Acme', email: 'hello@acme.test', city: 'Pune' },
        owner: {
          firstName: 'Ann',
          lastName: 'Owner',
          email: 'ann@acme.test',
          password: 'a-long-enough-password',
        },
      })
      .expect(201);
    const verified = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId: signup.body.data.verificationRefId, code: code() })
      .expect(200);

    // A business OWNER — the most authority anybody outside Wouchh can hold.
    await http()
      .post('/api/v1/platform/staff')
      .set(auth(verified.body.data.accessToken as string))
      .send({ firstName: 'Mole', email: 'mole@acme.test' })
      .expect(403);
  });
});
