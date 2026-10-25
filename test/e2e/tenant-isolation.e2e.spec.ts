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
        owner: {
          firstName: owner,
          lastName: 'Owner',
          email: `${owner}@${slug}.test`,
          password: PASSWORD,
        },
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

      await http().post(`/api/v1/roles/${theirs}/archive`).set(auth(acme.token)).expect(404);
    });

    it('leaves the other business’s role untouched after every attempt', async () => {
      /*
       * The refusals above are only worth something if nothing moved. A write
       * that 404s the caller and still lands is the worst outcome available.
       */
      const theirs = await roleRefId(rival, 'agent');
      const before = await http().get('/api/v1/roles').set(auth(rival.token)).expect(200);
      const beforeRole = (before.body.data as { refId: string }[]).find((r) => r.refId === theirs);

      await http()
        .patch(`/api/v1/roles/${theirs}`)
        .set(auth(acme.token))
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

      /*
       * E14, THE RESIDUAL — and the only version of this attack that required
       * the victim's own consent. Everything above is Acme acting
       * unilaterally; here the victim genuinely accepted a job at Acme, so
       * Acme is entitled to suspend THAT employment. What it is not entitled
       * to do is end the sessions the person uses at Rival.
       *
       * It used to. Sessions are keyed on the identity, so revoking "every
       * session for this identity" reached into an employer that had done
       * nothing. That was accepted while the alternative looked like a
       * suspended account still working — which it never was: refresh
       * re-checks employment per business, so Acme is protected without the
       * session being touched at all.
       */
      it('does not sign them out of their OTHER job, even having employed them', async () => {
        const victimRefId = await inviteVictim();
        await http()
          .post('/api/v1/auth/accept-invite')
          .send({ email: victimEmail, code: code(), password: 'a-password-only-they-know' })
          .expect(200);

        /*
         * Signed in to RIVAL after accepting, deliberately. Accepting an
         * invite sets a password and ends the identity's existing sessions —
         * correct, and it would otherwise leave nothing for this attack to
         * destroy. Two employments also mean login answers with a selection
         * token rather than a session, so the business has to be named: the
         * session being protected here is specifically Rival's.
         */
        const login = await http()
          .post('/api/v1/auth/login')
          .send({ email: victimEmail, password: 'a-password-only-they-know' })
          .expect(200);
        // Taken from the response rather than assumed, so the session created
        // is unambiguously the one at the OTHER employer.
        const choices = login.body.data.enterprises as { enterpriseRefId: string }[];
        const rivalChoice = choices.find((choice) => choice.enterpriseRefId !== acme.refId);
        await http()
          .post('/api/v1/auth/select-enterprise')
          .send({
            selectionToken: login.body.data.selectionToken as string,
            enterpriseRefId: rivalChoice?.enterpriseRefId,
          })
          .expect(200);

        const before = await liveSessions(victimEmail);
        expect(before).toBeGreaterThan(0);

        await http()
          .post(`/api/v1/employees/${victimRefId}/status`)
          .set(auth(acme.token))
          .send({ status: 'suspended', reason: 'no longer with us' })
          .expect(200);

        // Rival's sessions survive. Acme suspended an employment, not a person.
        expect(await liveSessions(victimEmail)).toBe(before);
      });

      /*
       * The other half, so the narrowing is not just "revoke less". Somebody
       * whose ONLY job is suspended should be signed out — otherwise
       * "suspended" means "cannot sign in again" rather than "is signed out",
       * which is not what anybody pressing that button believes.
       */
      it('DOES sign out somebody whose only employment is suspended', async () => {
        const solo = 'solo@acme.test';
        const agentRole = await roleRefId(acme, 'agent');
        const created = await http()
          .post('/api/v1/employees')
          .set(auth(acme.token))
          .send({ firstName: 'Solo', email: solo, roleRefId: agentRole })
          .expect(201);
        await http()
          .post('/api/v1/auth/accept-invite')
          .send({ email: solo, code: code(), password: 'a-password-only-solo-knows' })
          .expect(200);
        await http()
          .post('/api/v1/auth/login')
          .send({ email: solo, password: 'a-password-only-solo-knows' })
          .expect(200);

        expect(await liveSessions(solo)).toBeGreaterThan(0);

        await http()
          .post(`/api/v1/employees/${created.body.data.refId}/status`)
          .set(auth(acme.token))
          .send({ status: 'suspended', reason: 'no longer with us' })
          .expect(200);

        expect(await liveSessions(solo)).toBe(0);
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
      await http().post('/api/v1/features/post_insights/request').set(auth(acme.token)).expect(204);

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

  /**
   * REWARDS, which had no cross-tenant HTTP coverage at all.
   *
   * `reward-tenant-isolation.spec.ts` is the backstop underneath these and it
   * is a good one — composite foreign keys, driven in raw SQL — but it never
   * goes through a controller, so it cannot establish that a SERVICE resolves
   * a refId with an `enterprise_id` predicate. Two of these routes are writes
   * and two read a customer's financial position.
   */
  describe('rewards', () => {
    /** Switches the feature on for a business and returns a program of its own. */
    async function withRewards(business: Business): Promise<string> {
      const admin = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
      await http()
        .post(`/api/v1/platform/enterprises/${business.refId}/features/reward_programs`)
        .set(auth(admin.body.data.accessToken as string))
        .send({ status: 'active' })
        .expect(200);

      const program = await http()
        .post('/api/v1/rewards/programs')
        .set(auth(business.token))
        .send({ name: 'Monsoon' })
        .expect(201);
      return program.body.data.refId as string;
    }

    it('cannot read another business’s program history', async () => {
      const theirs = await withRewards(rival);
      await withRewards(acme);

      /* A REAL program belonging to a REAL other tenant — not a refId that
       * exists nowhere, which would pass with the predicate removed. */
      await http()
        .get(`/api/v1/rewards/programs/${theirs}/versions`)
        .set(auth(acme.token))
        .expect(404);
    });

    it('cannot archive another business’s program', async () => {
      const theirs = await withRewards(rival);
      await withRewards(acme);

      await http()
        .patch(`/api/v1/rewards/programs/${theirs}/status`)
        .set(auth(acme.token))
        .send({ status: 'archived' })
        .expect(404);

      /* And it is untouched: a 404 that still performed the write would be
       * the worse outcome of the two. */
      const theirView = await http()
        .get('/api/v1/rewards/programs')
        .set(auth(rival.token))
        .expect(200);
      expect(theirView.body.data.items[0].status).toBe('draft');
    });

    it('cannot switch another business’s rule on or off', async () => {
      const theirProgram = await withRewards(rival);
      await withRewards(acme);

      const theirRule = await http()
        .post('/api/v1/rewards/rules')
        .set(auth(rival.token))
        .send({
          programRefId: theirProgram,
          triggerKind: 'direct_message_inbound',
          benefits: [{ benefitKind: 'grant_points', config: { points: 10 } }],
          conditions: [],
        })
        .expect(201);

      await http()
        .patch(`/api/v1/rewards/rules/${theirRule.body.data.refId}/active`)
        .set(auth(acme.token))
        .send({ isActive: false })
        .expect(404);
    });

    it('cannot list another business’s rules', async () => {
      const theirs = await withRewards(rival);
      await withRewards(acme);

      await http()
        .get(`/api/v1/rewards/rules?programRefId=${theirs}`)
        .set(auth(acme.token))
        .expect(404);
    });

    /**
     * A customer's balance and award history are financial data about a named
     * person. Both are addressed by a customer refId, and a customer belongs to
     * exactly one business.
     */
    it('cannot read another business’s customer balances or awards', async () => {
      await withRewards(acme);

      const theirCustomer: { ref_id: string }[] = await db.query(
        `INSERT INTO customers (enterprise_id, first_source, status)
         SELECT e.id, 'direct_message', 'active' FROM enterprises e WHERE e.ref_id = $1
         RETURNING ref_id`,
        [rival.refId],
      );
      const refId = theirCustomer[0]?.ref_id as string;

      await http()
        .get(`/api/v1/rewards/customers/${refId}/balances`)
        .set(auth(acme.token))
        .expect(404);
      await http()
        .get(`/api/v1/rewards/customers/${refId}/awards`)
        .set(auth(acme.token))
        .expect(404);
    });
  });

  /**
   * THE INBOX WRITE ROUTES, which had no cross-tenant coverage.
   *
   * Five of them take a conversation `:refId`, and three of those act on a
   * customer's content or speak to them in the business's name. A refId that
   * resolves without an `enterprise_id` predicate is the whole attack.
   */
  describe('inbox', () => {
    /**
     * The attacker must get PAST gate 1, or the test proves nothing.
     *
     * Without the features, every call below is refused by the commercial gate
     * with `FEATURE_NOT_ENABLED` before tenancy is ever considered — a green
     * test asserting the wrong refusal. Granting them to the attacker leaves
     * the tenant predicate as the only thing standing in the way, which is
     * exactly what is under test.
     */
    async function withInbox(business: Business): Promise<void> {
      const admin = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
      const adminAuth = auth(admin.body.data.accessToken as string);
      for (const feature of ['unified_inbox', 'comment_management']) {
        await http()
          .post(`/api/v1/platform/enterprises/${business.refId}/features/${feature}`)
          .set(adminAuth)
          .send({ status: 'active' })
          .expect(200);
      }
    }

    /** The smallest conversation a moderation or reply call will accept. */
    async function seedConversation(business: Business): Promise<string> {
      const enterprise: { id: string }[] = await db.query(
        `SELECT id FROM enterprises WHERE ref_id = $1`,
        [business.refId],
      );
      const enterpriseId = enterprise[0]?.id;

      const connection: { id: string }[] = await db.query(
        `INSERT INTO provider_connections
           (enterprise_id, provider, provider_category, provider_user_id, access_token)
         VALUES ($1,'meta','social',$2,'envelope') RETURNING id`,
        [enterpriseId, `fbu-${business.refId}`],
      );
      const channel: { id: string }[] = await db.query(
        `INSERT INTO channels
           (provider_connection_id, enterprise_id, platform, channel_kind,
            platform_channel_id, name)
         VALUES ($1,$2,'facebook','page',$3,'Page') RETURNING id`,
        [connection[0]?.id, enterpriseId, `PAGE_${business.refId}`],
      );
      const customer: { id: string }[] = await db.query(
        `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
         VALUES ($1,'Grace','facebook_comment',$2) RETURNING id`,
        [enterpriseId, channel[0]?.id],
      );
      const post: { id: string }[] = await db.query(
        `INSERT INTO posts
           (enterprise_id, channel_id, platform, platform_post_id, post_kind, status, published_at)
         VALUES ($1,$2,'facebook',$3,'image','published', now()) RETURNING id`,
        [enterpriseId, channel[0]?.id, `POST_${business.refId}`],
      );
      const conversation: { ref_id: string; id: string }[] = await db.query(
        `INSERT INTO conversations
           (enterprise_id, channel_id, customer_id, post_id, platform, conversation_kind,
            platform_thread_id, status, message_count, last_message_at)
         VALUES ($1,$2,$3,$4,'facebook','comment_thread',$5,'open',1, now())
         RETURNING ref_id, id`,
        [enterpriseId, channel[0]?.id, customer[0]?.id, post[0]?.id, `thread-${business.refId}`],
      );
      await db.query(
        `INSERT INTO messages
           (enterprise_id, conversation_id, customer_id, direction, message_kind, body, status,
            platform_sent_at, platform_message_id)
         VALUES ($1,$2,$3,'inbound','text','is this open on Sundays?','delivered', now(), $4)`,
        [enterpriseId, conversation[0]?.id, customer[0]?.id, `CM_${business.refId}`],
      );
      return conversation[0]?.ref_id as string;
    }

    it('cannot reply into another business’s conversation', async () => {
      await withInbox(acme);
      const theirs = await seedConversation(rival);

      await http()
        .post(`/api/v1/conversations/${theirs}/reply`)
        .set(auth(acme.token))
        .send({ body: 'we are open', idempotencyKey: 'cross-tenant-reply' })
        .expect(404);
    });

    it('cannot assign another business’s conversation', async () => {
      await withInbox(acme);
      const theirs = await seedConversation(rival);

      await http()
        .post(`/api/v1/conversations/${theirs}/assign`)
        .set(auth(acme.token))
        .send({ employeeRefId: acme.agentEmployeeRefId })
        .expect(404);
    });

    it('cannot moderate a comment in another business’s conversation', async () => {
      await withInbox(acme);
      const theirs = await seedConversation(rival);
      const message: { ref_id: string }[] = await db.query(
        `SELECT m.ref_id FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.ref_id = $1`,
        [theirs],
      );

      await http()
        .post(`/api/v1/conversations/${theirs}/messages/${message[0]?.ref_id}/moderate`)
        .set(auth(acme.token))
        .send({ action: 'hide' })
        .expect(404);

      /* And the comment is untouched — a 404 that still queued the hide would
       * be the worse of the two outcomes. */
      const after: { is_hidden_on_platform: boolean }[] = await db.query(
        `SELECT is_hidden_on_platform FROM messages WHERE ref_id = $1`,
        [message[0]?.ref_id],
      );
      expect(after[0]?.is_hidden_on_platform).toBe(false);
    });

    it('cannot refresh attachments on another business’s conversation', async () => {
      await withInbox(acme);
      const theirs = await seedConversation(rival);

      await http()
        .post(`/api/v1/conversations/${theirs}/attachments/refresh`)
        .set(auth(acme.token))
        .expect(404);
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
