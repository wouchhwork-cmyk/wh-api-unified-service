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

const PASSWORD = 'a-long-enough-password';

/**
 * Two businesses, and every way one might reach the other.
 *
 * THE OTHER TESTS ASK WHETHER A FEATURE WORKS. This one asks whether a tenant
 * can touch something that is not theirs, and it asks through real HTTP with
 * two genuinely separate businesses rather than by reasoning about a query.
 *
 * Every case is an ATTACK, and every attack uses a REAL identifier belonging to
 * the other business. That distinction is the whole point: an earlier version
 * of one of these tests sent a refId belonging to nobody, which returns 404
 * from the ordinary not-found path — so removing the tenant predicate from the
 * query entirely would have left it green. A refId that genuinely exists
 * somewhere else is the only payload that tests isolation.
 *
 * WHY 404 AND NOT 403 throughout: a 403 would confirm the identifier exists,
 * and a refId is the only handle a client has. Somebody probing must not be
 * able to tell "not yours" from "not a thing".
 */
describe('one business cannot reach another', () => {
  let testApp: TestApp;
  let app: NestExpressApplication;
  let db: DataSource;

  let acme: Business;
  let rival: Business;

  interface Business {
    token: string;
    refId: string;
    ownerEmployeeRefId: string;
    agentEmployeeRefId: string;
    agentToken: string;
  }

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
    acme = await onboard('Acme Coffee', 'acme', 'Ann');
    rival = await onboard('Rival Roasters', 'rival', 'Bo');
  });

  const http = () => request(app.getHttpServer());
  const code = (): string => process.env.OTP_STATIC_CODE ?? '666666';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function onboard(name: string, slug: string, owner: string): Promise<Business> {
    const signup = await http()
      .post('/api/v1/enterprises/signup')
      .send({
        business: { name, email: `hello@${slug}.test`, city: 'Pune' },
        owner: { firstName: owner, lastName: 'Owner', email: `${owner}@${slug}.test`, password: PASSWORD },
      })
      .expect(201);
    const verified = await http()
      .post('/api/v1/auth/verify')
      .send({ verificationRefId: signup.body.data.verificationRefId, code: code() })
      .expect(200);

    const admin = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
    await http()
      .post(`/api/v1/platform/enterprises/${signup.body.data.enterpriseRefId}/status`)
      .set(auth(admin.body.data.accessToken as string))
      .send({ status: 'active' })
      .expect(200);

    const token = verified.body.data.accessToken as string;

    // An agent, so there is somebody below the owner to be acted on.
    const roles = await http().get('/api/v1/roles').set(auth(token)).expect(200);
    const agentRole = (roles.body.data as { refId: string; name: string }[]).find(
      (role) => role.name === 'agent',
    );
    const agentEmail = `agent@${slug}.test`;
    const created = await http()
      .post('/api/v1/employees')
      .set(auth(token))
      .send({ firstName: 'Agent', email: agentEmail, roleRefId: agentRole?.refId })
      .expect(201);
    const accepted = await http()
      .post('/api/v1/auth/accept-invite')
      .send({ email: agentEmail, code: code(), password: PASSWORD })
      .expect(200);

    const team = await http().get('/api/v1/employees').set(auth(token)).expect(200);
    const ownerRow = (team.body.data as { refId: string; name: string }[]).find((person) =>
      person.name.startsWith(owner),
    );

    return {
      token,
      refId: signup.body.data.enterpriseRefId as string,
      ownerEmployeeRefId: ownerRow?.refId as string,
      agentEmployeeRefId: created.body.data.refId as string,
      agentToken: accepted.body.data.accessToken as string,
    };
  }

  const roleRefId = async (business: Business, name: string): Promise<string> => {
    const roles = await http().get('/api/v1/roles').set(auth(business.token)).expect(200);
    const match = (roles.body.data as { refId: string; name: string }[]).find(
      (role) => role.name === name,
    );
    if (!match) throw new Error(`role ${name} missing`);
    return match.refId;
  };

  describe('roles', () => {
    it('cannot assign another business’s role', async () => {
      // Rival's agent role genuinely exists — just not here.
      const theirs = await roleRefId(rival, 'agent');

      await http()
        .post(`/api/v1/roles/employees/${acme.agentEmployeeRefId}`)
        .set(auth(acme.token))
        .send({ roleRefIds: [theirs] })
        .expect(404);
    });

    it('cannot edit another business’s role', async () => {
      const theirs = await roleRefId(rival, 'agent');

      await http()
        .patch(`/api/v1/roles/${theirs}`)
        .set(auth(acme.token))
        .send({ name: 'hijacked', level: 5, permissions: [] })
        .expect(404);
    });

    it('cannot archive another business’s role', async () => {
      const theirs = await roleRefId(rival, 'agent');

      await http()
        .post(`/api/v1/roles/${theirs}/archive`)
        .set(auth(acme.token))
        .expect(404);
    });

    it('leaves the other business’s role untouched after every attempt', async () => {
      /*
       * The refusals above are only worth something if nothing moved. A write
       * that 404s the caller and still lands is the worst outcome available.
       */
      const theirs = await roleRefId(rival, 'agent');
      const before = await http().get('/api/v1/roles').set(auth(rival.token)).expect(200);
      const beforeRole = (before.body.data as { refId: string }[]).find((r) => r.refId === theirs);

      await http().patch(`/api/v1/roles/${theirs}`).set(auth(acme.token))
        .send({ name: 'hijacked', level: 5, permissions: [] });
      await http().post(`/api/v1/roles/${theirs}/archive`).set(auth(acme.token));

      const after = await http().get('/api/v1/roles').set(auth(rival.token)).expect(200);
      const afterRole = (after.body.data as { refId: string }[]).find((r) => r.refId === theirs);

      expect(afterRole).toEqual(beforeRole);
    });

    it('sees only its own roles, and its own holder counts', async () => {
      const mine = await http().get('/api/v1/roles').set(auth(acme.token)).expect(200);
      const theirs = await http().get('/api/v1/roles').set(auth(rival.token)).expect(200);

      const mineRefs = (mine.body.data as { refId: string }[]).map((r) => r.refId);
      const theirRefs = (theirs.body.data as { refId: string }[]).map((r) => r.refId);

      // Same NAMES — every business gets copies of the same templates — and no
      // shared identifiers whatsoever.
      expect(mineRefs).toHaveLength(4);
      expect(mineRefs.filter((ref) => theirRefs.includes(ref))).toEqual([]);
    });

    it('may reuse a role name the other business already uses', async () => {
      // Names are unique WITHIN a business. If they were global, one tenant
      // could deny another a name simply by taking it first.
      const body = { name: 'Weekend cover', level: 30, permissions: ['conversations.view'] };

      await http().post('/api/v1/roles').set(auth(acme.token)).send(body).expect(201);
      await http().post('/api/v1/roles').set(auth(rival.token)).send(body).expect(201);
    });

    it('creating a role does not touch the shared templates', async () => {
      /*
       * The NULL-enterprise rows are ours, shared by every business. A tenant
       * write that reached one would change what every future signup inherits.
       */
      const before: { n: string }[] = await db.query(
        `SELECT count(*)::text AS n FROM roles WHERE enterprise_id IS NULL`,
      );

      await http()
        .post('/api/v1/roles')
        .set(auth(acme.token))
        .send({ name: 'Mine', level: 20, permissions: [] })
        .expect(201);

      const after: { n: string }[] = await db.query(
        `SELECT count(*)::text AS n FROM roles WHERE enterprise_id IS NULL`,
      );
      expect(after[0]?.n).toBe(before[0]?.n);

      // And the new row belongs to Acme, is not a system role, and is theirs alone.
      const created: { enterprise_id: string; is_system: boolean }[] = await db.query(
        `SELECT enterprise_id, is_system FROM roles WHERE name = 'Mine'`,
      );
      expect(created).toHaveLength(1);
      expect(created[0]?.is_system).toBe(false);
    });
  });

  describe('people', () => {
    it('cannot re-role another business’s employee', async () => {
      const mine = await roleRefId(acme, 'agent');

      await http()
        .post(`/api/v1/roles/employees/${rival.agentEmployeeRefId}`)
        .set(auth(acme.token))
        .send({ roleRefIds: [mine] })
        .expect(404);
    });

    it('cannot suspend another business’s employee', async () => {
      await http()
        .post(`/api/v1/employees/${rival.agentEmployeeRefId}/status`)
        .set(auth(acme.token))
        .send({ status: 'suspended', reason: 'not mine to suspend' })
        .expect(404);
    });

    it('cannot suspend another business’s OWNER', async () => {
      // The most valuable target: suspending somebody ends every session that
      // identity holds, across every business they work for.
      await http()
        .post(`/api/v1/employees/${rival.ownerEmployeeRefId}/status`)
        .set(auth(acme.token))
        .send({ status: 'suspended', reason: 'takeover' })
        .expect(404);
    });

    it('leaves the other business’s people working afterwards', async () => {
      await http()
        .post(`/api/v1/employees/${rival.agentEmployeeRefId}/status`)
        .set(auth(acme.token))
        .send({ status: 'suspended', reason: 'x' });

      // Rival's agent can still use their session.
      await http().get('/api/v1/roles').set(auth(rival.agentToken)).expect(200);
    });

    /*
     * THE ATTACK THAT GOT THROUGH, and the reason the three tests above were
     * not enough.
     *
     * Every one of them hands Acme a refId belonging to Rival and checks for a
     * 404 — which is the right question for "can A address B's row?" and
     * entirely the wrong one here. This attack never addresses Rival's row. It
     * uses a refId that genuinely belongs to ACME, acting on an employment
     * record Acme was allowed to create, and reaches across only at the end:
     * identities are global, so the row points at a human who works for Rival,
     * and suspending an employment revokes every session that HUMAN holds.
     *
     * Tenant isolation held perfectly and the victim was still signed out.
     */
    describe('inviting somebody who already works elsewhere', () => {
      const victimEmail = 'agent@rival.test';

      /*
       * THE SESSIONS THEMSELVES, not a request made with an access token.
       *
       * The first version of the two tests below asserted that Rival's agent
       * could still call the API, and they PASSED against the unfixed code —
       * proving nothing. Revocation ends SESSIONS (the refresh side), while an
       * access token is self-contained and stays valid for its full lifetime
       * whatever the sessions table says. So the attack signed the victim out
       * and the test could not see it. This counts the rows the attack destroys.
       */
      const liveSessions = async (email: string): Promise<number> => {
        const rows: { count: string }[] = await db.query(
          `SELECT count(*)::text AS count
             FROM sessions s
             JOIN identities i ON i.id = s.identity_id
            WHERE i.email = $1 AND s.revoked_at IS NULL`,
          [email],
        );
        return Number(rows[0]?.count ?? 0);
      };

      const inviteVictim = async (): Promise<string> => {
        const agentRole = await roleRefId(acme, 'agent');
        const created = await http()
          .post('/api/v1/employees')
          .set(auth(acme.token))
          .send({ firstName: 'Victim', email: victimEmail, roleRefId: agentRole })
          .expect(201);
        return created.body.data.refId as string;
      };

      it('attaches to their existing identity, which is deliberate', async () => {
        // Not the bug — one human, one password, however many jobs. It is the
        // premise the rest of these tests are built on.
        await expect(inviteVictim()).resolves.toBeTruthy();
      });

      it('cannot activate an invite on their behalf', async () => {
        /*
         * The direct route. Acme holds employees.manage over a row it created,
         * so RBAC has no objection — only the state machine does.
         */
        const refId = await inviteVictim();

        await http()
          .post(`/api/v1/employees/${refId}/status`)
          .set(auth(acme.token))
          .send({ status: 'active', reason: 'on their behalf' })
          .expect(409);
      });

      it('cannot launder an invite into an employment by suspending first', async () => {
        /*
         * The two-hop route, and the one a narrower fix would have missed:
         * cancelling an invite is legitimate, so invited -> suspended is
         * allowed, and suspended -> active would then be an ordinary
         * reinstatement of a row that was never real.
         */
        const refId = await inviteVictim();

        await http()
          .post(`/api/v1/employees/${refId}/status`)
          .set(auth(acme.token))
          .send({ status: 'suspended', reason: 'cancel' })
          .expect(200);

        await http()
          .post(`/api/v1/employees/${refId}/status`)
          .set(auth(acme.token))
          .send({ status: 'active', reason: 'reinstate' })
          .expect(409);
      });

      it('does not sign the victim out of the business they actually work for', async () => {
        /*
         * THE ASSERTION THAT MATTERS. Everything above could be wrong and this
         * would still catch the damage: Rival's agent holds a live session, and
         * nothing Acme does to a row Acme invented may end it.
         */
        const refId = await inviteVictim();
        const before = await liveSessions(victimEmail);
        expect(before).toBeGreaterThan(0);

        await http()
          .post(`/api/v1/employees/${refId}/status`)
          .set(auth(acme.token))
          .send({ status: 'suspended', reason: 'sign them out' })
          .expect(200);

        expect(await liveSessions(victimEmail)).toBe(before);
      });

      it('cannot sign them out by repeating it', async () => {
        // The denial-of-service shape: two requests per logout, as fast as the
        // throttler allows. Each pass must be inert, not merely the first.
        const refId = await inviteVictim();

        const before = await liveSessions(victimEmail);

        for (let attempt = 0; attempt < 3; attempt += 1) {
          await http()
            .post(`/api/v1/employees/${refId}/status`)
            .set(auth(acme.token))
            .send({ status: 'suspended', reason: 'again' });
          await http()
            .post(`/api/v1/employees/${refId}/status`)
            .set(auth(acme.token))
            .send({ status: 'active', reason: 'again' });
        }

        expect(await liveSessions(victimEmail)).toBe(before);
        // And they can still actually use the platform.
        await http().get('/api/v1/roles').set(auth(rival.agentToken)).expect(200);
      });
    });

    it('sees only its own team', async () => {
      const team = await http().get('/api/v1/employees').set(auth(acme.token)).expect(200);
      const refs = (team.body.data as { refId: string }[]).map((person) => person.refId);

      expect(refs).toContain(acme.agentEmployeeRefId);
      expect(refs).not.toContain(rival.agentEmployeeRefId);
      expect(refs).not.toContain(rival.ownerEmployeeRefId);
    });

    it('cannot invite into another business by naming its role', async () => {
      const theirs = await roleRefId(rival, 'agent');

      await http()
        .post('/api/v1/employees')
        .set(auth(acme.token))
        .send({ firstName: 'Mole', email: 'mole@acme.test', roleRefId: theirs })
        .expect(404);
    });
  });

  describe('features', () => {
    it('sees only its own standing', async () => {
      const admin = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
      await http()
        .post(`/api/v1/platform/enterprises/${rival.refId}/features/post_insights`)
        .set(auth(admin.body.data.accessToken as string))
        .send({ status: 'active' })
        .expect(200);

      const mine = await http().get('/api/v1/features').set(auth(acme.token)).expect(200);
      const granted = (mine.body.data as { key: string; active: boolean }[]).find(
        (feature) => feature.key === 'post_insights',
      );

      // Rival has it; Acme must not see it as theirs.
      expect(granted?.active).toBe(false);
    });

    it('requesting a feature does not touch the other business', async () => {
      await http()
        .post('/api/v1/features/post_insights/request')
        .set(auth(acme.token))
        .expect(204);

      const theirs = await http().get('/api/v1/features').set(auth(rival.token)).expect(200);
      const feature = (theirs.body.data as { key: string; status: string | null }[]).find(
        (entry) => entry.key === 'post_insights',
      );
      expect(feature?.status).toBeNull();
    });
  });

  describe('the platform surface', () => {
    it('is closed to a business owner entirely', async () => {
      for (const path of [
        '/api/v1/platform/overview',
        '/api/v1/platform/enterprises',
        '/api/v1/platform/staff',
        '/api/v1/platform/rate-limits',
      ]) {
        await http().get(path).set(auth(acme.token)).expect(403);
      }
    });

    it('will not let a business act on another through the platform routes', async () => {
      // The one place a tenant could name another tenant's refId directly.
      await http()
        .post(`/api/v1/platform/enterprises/${rival.refId}/status`)
        .set(auth(acme.token))
        .send({ status: 'suspended', reason: 'competition' })
        .expect(403);
    });
  });

  describe('what the database refuses regardless of the code', () => {
    it('cannot pair one business’s employee with another’s role', async () => {
      /*
       * The backstop under all of the above. Every service check could be
       * removed and this would still hold, because `employee_roles` routes both
       * foreign keys through `enterprise_id`.
       */
      const theirRole: { id: string }[] = await db.query(
        `SELECT r.id FROM roles r JOIN enterprises e ON e.id = r.enterprise_id
          WHERE e.ref_id = $1 AND r.name = 'agent'`,
        [rival.refId],
      );
      const myEmployee: { id: string; enterprise_id: string }[] = await db.query(
        `SELECT id, enterprise_id FROM enterprise_employees WHERE ref_id = $1`,
        [acme.agentEmployeeRefId],
      );

      await expect(
        db.query(
          `INSERT INTO employee_roles (enterprise_id, employee_id, role_id) VALUES ($1,$2,$3)`,
          [myEmployee[0]?.enterprise_id, myEmployee[0]?.id, theirRole[0]?.id],
        ),
      ).rejects.toThrow(/employee_roles_role_fk|foreign key/i);
    });
  });
});
