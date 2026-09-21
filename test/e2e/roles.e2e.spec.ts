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
import { ROLE_LEVEL } from '@/shared/enums';

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

/**
 * A business defining its own roles.
 *
 * This is the feature the whole levelling exercise was a precondition for, and
 * the reason it could not ship earlier: role editing without the level and
 * subset rules is a privilege-escalation route, not a feature. A manager with
 * `roles.manage` could define a role below themselves carrying
 * `enterprise.manage`, grant it to a colleague, and have that colleague do what
 * the manager cannot.
 *
 * So most of what is asserted here is refusal.
 */
describe('a business defines its own roles', () => {
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
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function onboardedBusiness(): Promise<{ ownerToken: string; enterpriseRefId: string }> {
    const signup = await http().post('/api/v1/enterprises/signup').send(SIGNUP).expect(201);
    const verified = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId: signup.body.data.verificationRefId, code: code() })
      .expect(200);

    const admin = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
    await http()
      .post(`/api/v1/platform/enterprises/${signup.body.data.enterpriseRefId}/status`)
      .set(bearer(admin.body.data.accessToken as string))
      .send({ status: 'active' })
      .expect(200);

    return {
      ownerToken: verified.body.data.accessToken as string,
      enterpriseRefId: signup.body.data.enterpriseRefId as string,
    };
  }

  async function roleRefId(token: string, name: string): Promise<string> {
    const roles = await http().get('/api/v1/roles').set(bearer(token)).expect(200);
    const match = (roles.body.data as { refId: string; name: string }[]).find(
      (role) => role.name === name,
    );
    if (!match) throw new Error(`role ${name} not found`);
    return match.refId;
  }

  /** Invites somebody into a role and returns their accepted token and refId. */
  async function member(
    ownerToken: string,
    firstName: string,
    email: string,
    role: string,
  ): Promise<{ token: string; refId: string }> {
    const created = await http()
      .post('/api/v1/employees')
      .set(bearer(ownerToken))
      .send({ firstName, email, roleRefId: await roleRefId(ownerToken, role) })
      .expect(201);
    const accepted = await http()
      .post('/api/v1/auth/accept-invite')
      .send({ email, code: code(), password: OWNER_PASSWORD })
      .expect(200);
    return {
      token: accepted.body.data.accessToken as string,
      refId: created.body.data.refId as string,
    };
  }

  describe('the permission list a person actually sees', () => {
    it('is grouped by area, in reading order, not alphabetically', async () => {
      const { ownerToken } = await onboardedBusiness();

      const response = await http()
        .get('/api/v1/roles/permissions')
        .set(bearer(ownerToken))
        .expect(200);

      const groups = response.body.data as { resource: string; label: string }[];
      const resources = groups.map((group) => group.resource);

      // Daily work first, configuration last. Alphabetically `channels` would
      // come first and bury the inbox under the plumbing.
      expect(resources.indexOf('conversations')).toBeLessThan(resources.indexOf('channels'));
      expect(resources.indexOf('mentions')).toBeLessThan(resources.indexOf('enterprise'));
      expect(groups.every((group) => group.label.length > 0)).toBe(true);
    });

    it('has a mentions section, which is the whole point of the split', async () => {
      const { ownerToken } = await onboardedBusiness();

      const response = await http()
        .get('/api/v1/roles/permissions')
        .set(bearer(ownerToken))
        .expect(200);

      const mentions = (response.body.data as { resource: string; permissions: unknown[] }[]).find(
        (group) => group.resource === 'mentions',
      );

      expect(mentions).toBeDefined();
      const codes = (mentions?.permissions as { code: string }[]).map((p) => p.code);
      expect(codes).toEqual(
        expect.arrayContaining([
          'mentions.view',
          'mentions.reply',
          'mentions.assign',
          'mentions.manage',
        ]),
      );
      // Deliberately absent: a mention lives on somebody else's post and Meta
      // gives us no way to hide or delete it.
      expect(codes).not.toContain('mentions.hide');
      expect(codes).not.toContain('mentions.delete');
    });

    it('marks what a manager may not hand out, rather than hiding it', async () => {
      /*
       * `enterprise.manage` is withheld from the manager template, so a manager
       * must see it and must not be able to grant it. Showing it greyed is the
       * deliberate choice: hiding it would make an owner-built role that grants
       * it look corrupt in the manager's editor.
       */
      const { ownerToken } = await onboardedBusiness();
      const manager = await member(ownerToken, 'Priya', 'priya@bluebottle.test', 'manager');

      const response = await http()
        .get('/api/v1/roles/permissions')
        .set(bearer(manager.token))
        .expect(200);

      const all = (response.body.data as { permissions: { code: string; grantable: boolean }[] }[])
        .flatMap((group) => group.permissions);
      const billing = all.find((permission) => permission.code === 'enterprise.manage');

      expect(billing).toBeDefined();
      expect(billing?.grantable).toBe(false);
      expect(all.find((p) => p.code === 'conversations.view')?.grantable).toBe(true);
    });

    it('never offers a staff-only permission to a business', async () => {
      // `features.decide` is ours: approving a business's feature request. In a
      // tenant's role editor it would be a toggle that can never do anything.
      const { ownerToken } = await onboardedBusiness();

      const response = await http()
        .get('/api/v1/roles/permissions')
        .set(bearer(ownerToken))
        .expect(200);

      const codes = (response.body.data as { permissions: { code: string }[] }[])
        .flatMap((group) => group.permissions)
        .map((permission) => permission.code);

      expect(codes).not.toContain('features.decide');
    });
  });

  describe('creating a role', () => {
    it('lets an owner build one below themselves', async () => {
      const { ownerToken } = await onboardedBusiness();

      const created = await http()
        .post('/api/v1/roles')
        .set(bearer(ownerToken))
        .send({
          name: 'Mentions only',
          description: 'Handles public mentions and nothing else',
          level: 35,
          permissions: ['mentions.view', 'mentions.reply', 'mentions.assign'],
        })
        .expect(201);

      expect(created.body.data).toMatchObject({
        name: 'Mentions only',
        level: 35,
        isSystem: false,
        holderCount: 0,
      });
      expect(created.body.data.permissions).toEqual(
        expect.arrayContaining(['mentions.view', 'mentions.reply', 'mentions.assign']),
      );
    });

    it('REFUSES a role at or above the creator level', async () => {
      const { ownerToken } = await onboardedBusiness();
      const manager = await member(ownerToken, 'Priya', 'priya@bluebottle.test', 'manager');

      const refused = await http()
        .post('/api/v1/roles')
        .set(bearer(manager.token))
        .send({ name: 'Co-manager', level: ROLE_LEVEL.Manager, permissions: ['conversations.view'] })
        .expect(403);

      expect(refused.body.error.details[0].issue).toMatch(/below your own level/i);
    });

    it('REFUSES a role carrying a permission the creator does not hold', async () => {
      /*
       * The subtle escalation, and the reason this endpoint could not exist
       * before the subset rule. The level is fine — well below the manager —
       * but the role would carry billing, which the manager does not have.
       * Grant it to somebody and they can do what the manager cannot.
       */
      const { ownerToken } = await onboardedBusiness();
      const manager = await member(ownerToken, 'Priya', 'priya@bluebottle.test', 'manager');

      const refused = await http()
        .post('/api/v1/roles')
        .set(bearer(manager.token))
        .send({
          name: 'Quiet billing',
          level: 20,
          permissions: ['conversations.view', 'enterprise.manage'],
        })
        .expect(403);

      expect(refused.body.error.details[0].issue).toMatch(/permissions you do not hold/i);
    });

    it('REFUSES the owner level even to an owner', async () => {
      // There is exactly one top of the ladder and it comes from the seed. A
      // second owner-level role would be a way around every owner rule that
      // checks the name.
      const { ownerToken } = await onboardedBusiness();

      await http()
        .post('/api/v1/roles')
        .set(bearer(ownerToken))
        .send({ name: 'Super', level: ROLE_LEVEL.Owner, permissions: [] })
        .expect(422);
    });

    it('REFUSES an agent entirely, who has no roles.manage', async () => {
      const { ownerToken } = await onboardedBusiness();
      const agent = await member(ownerToken, 'Junior', 'junior@bluebottle.test', 'agent');

      const refused = await http()
        .post('/api/v1/roles')
        .set(bearer(agent.token))
        .send({ name: 'Anything', level: 5, permissions: [] })
        .expect(403);

      expect(refused.body.error.code).toBe('PERMISSION_DENIED');
    });

    it('refuses a duplicate name', async () => {
      const { ownerToken } = await onboardedBusiness();
      const body = { name: 'Weekend cover', level: 30, permissions: ['conversations.view'] };

      await http().post('/api/v1/roles').set(bearer(ownerToken)).send(body).expect(201);
      await http().post('/api/v1/roles').set(bearer(ownerToken)).send(body).expect(422);
    });
  });

  describe('editing a role', () => {
    it('REFUSES to edit a built-in role', async () => {
      /*
       * Otherwise the whole ladder is editable: change what `agent` means and
       * every agent changes with it, including ones granted by somebody more
       * senior. A business that wants a different agent makes its own role.
       */
      const { ownerToken } = await onboardedBusiness();
      const agentRole = await roleRefId(ownerToken, 'agent');

      const refused = await http()
        .patch(`/api/v1/roles/${agentRole}`)
        .set(bearer(ownerToken))
        .send({ name: 'agent', level: 40, permissions: [] })
        .expect(403);

      expect(refused.body.error.details[0].issue).toMatch(/built-in/i);
    });

    it('REFUSES a manager editing a role above them, even downwards', async () => {
      /*
       * Checking only the NEW state would let somebody edit a role above them
       * down to a level they outrank and walk away holding the edit — the level
       * requested is theirs to choose, so it proves nothing about what they
       * were allowed to touch.
       */
      const { ownerToken } = await onboardedBusiness();
      const manager = await member(ownerToken, 'Priya', 'priya@bluebottle.test', 'manager');

      const senior = await http()
        .post('/api/v1/roles')
        .set(bearer(ownerToken))
        .send({ name: 'Deputy', level: 90, permissions: ['conversations.view'] })
        .expect(201);

      await http()
        .patch(`/api/v1/roles/${senior.body.data.refId}`)
        .set(bearer(manager.token))
        .send({ name: 'Deputy', level: 10, permissions: ['conversations.view'] })
        .expect(403);
    });

    it('replaces the permission set wholesale', async () => {
      const { ownerToken } = await onboardedBusiness();
      const created = await http()
        .post('/api/v1/roles')
        .set(bearer(ownerToken))
        .send({ name: 'Trial', level: 30, permissions: ['mentions.view', 'mentions.reply'] })
        .expect(201);

      const updated = await http()
        .patch(`/api/v1/roles/${created.body.data.refId}`)
        .set(bearer(ownerToken))
        .send({ name: 'Trial', level: 30, permissions: ['mentions.view'] })
        .expect(200);

      // Removed, not merged. A partial update of a permission SET is ambiguous
      // and the ambiguity is a silent total revocation.
      expect(updated.body.data.permissions).toEqual(['mentions.view']);
    });
  });

  describe('retiring a role', () => {
    it('refuses while somebody still holds it', async () => {
      const { ownerToken } = await onboardedBusiness();
      const created = await http()
        .post('/api/v1/roles')
        .set(bearer(ownerToken))
        .send({ name: 'Temp', level: 30, permissions: ['conversations.view'] })
        .expect(201);

      const person = await member(ownerToken, 'Junior', 'junior@bluebottle.test', 'agent');
      await http()
        .post(`/api/v1/roles/employees/${person.refId}`)
        .set(bearer(ownerToken))
        .send({ roleRefIds: [created.body.data.refId] })
        .expect(204);

      const refused = await http()
        .post(`/api/v1/roles/${created.body.data.refId}/archive`)
        .set(bearer(ownerToken))
        .expect(422);

      expect(refused.body.error.details[0].issue).toMatch(/still hold this role/i);
    });

    it('retires one nobody holds, and stops it being assignable', async () => {
      const { ownerToken } = await onboardedBusiness();
      const created = await http()
        .post('/api/v1/roles')
        .set(bearer(ownerToken))
        .send({ name: 'Unused', level: 30, permissions: [] })
        .expect(201);

      await http()
        .post(`/api/v1/roles/${created.body.data.refId}/archive`)
        .set(bearer(ownerToken))
        .expect(204);

      const remaining = await http().get('/api/v1/roles').set(bearer(ownerToken)).expect(200);
      expect((remaining.body.data as { name: string }[]).map((r) => r.name)).not.toContain('Unused');
    });
  });

  describe('changing what somebody holds', () => {
    it('promotes an agent into a role the owner made', async () => {
      const { ownerToken } = await onboardedBusiness();
      const created = await http()
        .post('/api/v1/roles')
        .set(bearer(ownerToken))
        .send({ name: 'Shift lead', level: 55, permissions: ['conversations.view'] })
        .expect(201);
      const person = await member(ownerToken, 'Junior', 'junior@bluebottle.test', 'agent');

      await http()
        .post(`/api/v1/roles/employees/${person.refId}`)
        .set(bearer(ownerToken))
        .send({ roleRefIds: [created.body.data.refId] })
        .expect(204);

      const team = await http().get('/api/v1/employees').set(bearer(ownerToken)).expect(200);
      const junior = (team.body.data as { name: string; roles: string[]; roleLevel: number }[]).find(
        (p) => p.name === 'Junior',
      );
      expect(junior?.roles).toEqual(['Shift lead']);
      expect(junior?.roleLevel).toBe(55);
    });

    it('REFUSES promoting somebody into your own level', async () => {
      const { ownerToken } = await onboardedBusiness();
      const manager = await member(ownerToken, 'Priya', 'priya@bluebottle.test', 'manager');
      const person = await member(ownerToken, 'Junior', 'junior@bluebottle.test', 'agent');
      const managerRole = await roleRefId(ownerToken, 'manager');

      const refused = await http()
        .post(`/api/v1/roles/employees/${person.refId}`)
        .set(bearer(manager.token))
        .send({ roleRefIds: [managerRole] })
        .expect(403);

      expect(refused.body.error.details[0].issue).toMatch(/below your own level/i);
    });

    it('REFUSES promoting yourself', async () => {
      /*
       * The most direct attack on this endpoint. Blocked by the self rule
       * rather than by the level rule, and reported as such — "you do not
       * outrank them" is also true of yourself and would be a baffling way to
       * be told.
       */
      const { ownerToken } = await onboardedBusiness();
      const manager = await member(ownerToken, 'Priya', 'priya@bluebottle.test', 'manager');
      const ownerRole = await roleRefId(ownerToken, 'owner');

      const refused = await http()
        .post(`/api/v1/roles/employees/${manager.refId}`)
        .set(bearer(manager.token))
        .send({ roleRefIds: [ownerRole] })
        .expect(403);

      expect(refused.body.error.details[0].issue).toMatch(/your own account/i);
    });

    it('REFUSES a mixed set where only one role is too senior', async () => {
      // Every role is checked, not just the highest — otherwise a junior role
      // alongside a senior one would carry the senior one through.
      const { ownerToken } = await onboardedBusiness();
      const manager = await member(ownerToken, 'Priya', 'priya@bluebottle.test', 'manager');
      const person = await member(ownerToken, 'Junior', 'junior@bluebottle.test', 'agent');

      await http()
        .post(`/api/v1/roles/employees/${person.refId}`)
        .set(bearer(manager.token))
        .send({
          roleRefIds: [await roleRefId(ownerToken, 'agent'), await roleRefId(ownerToken, 'manager')],
        })
        .expect(403);
    });

    it('refuses a role that belongs to another business', async () => {
      const { ownerToken } = await onboardedBusiness();
      const person = await member(ownerToken, 'Junior', 'junior@bluebottle.test', 'agent');

      await http()
        .post(`/api/v1/roles/employees/${person.refId}`)
        .set(bearer(ownerToken))
        .send({ roleRefIds: ['00000000-0000-4000-8000-000000000000'] })
        .expect(404);
    });
  });

  describe('what the listing tells a client', () => {
    it('says which roles this caller may edit and assign', async () => {
      /*
       * So a client does not offer a button the server will refuse. A manager
       * sees the owner role — they need to know it exists — and is told they
       * can neither edit nor assign it.
       */
      const { ownerToken } = await onboardedBusiness();
      const manager = await member(ownerToken, 'Priya', 'priya@bluebottle.test', 'manager');

      const roles = await http().get('/api/v1/roles').set(bearer(manager.token)).expect(200);
      const byName = new Map(
        (roles.body.data as { name: string; editable: boolean; assignable: boolean }[]).map(
          (role) => [role.name, role],
        ),
      );

      expect(byName.get('owner')).toMatchObject({ editable: false, assignable: false });
      expect(byName.get('manager')).toMatchObject({ editable: false, assignable: false });
      expect(byName.get('agent')).toMatchObject({ editable: false, assignable: true });
    });
  });
});
