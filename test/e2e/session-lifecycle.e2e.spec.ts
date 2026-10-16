import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SecretHashService } from '@/shared/crypto';
import { MAX_SESSIONS_PER_IDENTITY } from '@/shared/constants';
import { AuditAction, AuditEntityType, EmployeeStatus } from '@/shared/enums';
import {
  createTestApp,
  platformAdminLogin,
  provisionPlatformAdmin,
  resetTenantData,
  type TestApp,
} from './app.harness';

const OWNER = {
  business: { name: 'Acme Coffee', email: 'hello@acmecoffee.test', city: 'Pune' },
  owner: {
    firstName: 'Priya',
    lastName: 'Sharma',
    email: 'priya@acmecoffee.test',
    password: 'a-long-enough-password',
  },
};

const OTHER = {
  business: { name: 'Bakery Ltd', email: 'hello@bakery.test', city: 'Pune' },
  owner: {
    firstName: 'Rohit',
    lastName: 'Verma',
    email: 'rohit@bakery.test',
    password: 'a-long-enough-password',
  },
};

/**
 * The end of a session's life, over HTTP.
 *
 * Two gaps closed here, and the tests are written as the defects rather than as
 * the feature:
 *
 *   - `POST /auth/refresh` re-checked employment ONLY when the caller passed
 *     `?enterpriseRefId=`, so anybody suspended could keep minting access tokens
 *     for a week by leaving the parameter off;
 *   - nothing capped concurrent sessions and nothing let a person end all of
 *     their own, so a leaked cookie could only be dealt with by an administrator
 *     suspending the account.
 *
 * The cases that must keep WORKING are the point of the first group: having no
 * employment at all is legitimate, so the rule cannot simply require one.
 */
describe('session lifecycle', () => {
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

  /** The `refreshToken=...` pair from a response, ready to send back. */
  function refreshCookie(response: request.Response): string {
    const cookies = (response.headers['set-cookie'] ?? []) as unknown as string[];
    const cookie = cookies.find((value) => value.startsWith('refreshToken='));
    if (!cookie) throw new Error('the response set no refresh cookie');
    return cookie.split(';')[0] as string;
  }

  interface SignedIn {
    readonly token: string;
    readonly cookie: string;
    readonly enterpriseRefId: string;
  }

  /** Signs up a business and proves the owner's address, which signs them in. */
  async function onboard(signup: typeof OWNER): Promise<SignedIn> {
    const created = await http().post('/api/v1/enterprises/signup').send(signup).expect(201);
    const verified = await http()
      .post('/api/v1/auth/verify')
      .send({
        verificationRefId: created.body.data.verificationRefId,
        code: process.env.OTP_STATIC_CODE,
      })
      .expect(200);

    expect(verified.body.data.outcome).toBe('authenticated');
    return {
      token: verified.body.data.accessToken as string,
      cookie: refreshCookie(verified),
      enterpriseRefId: created.body.data.enterpriseRefId as string,
    };
  }

  /** A second session for somebody already onboarded — the address is proven now. */
  async function signInAgain(signup: typeof OWNER): Promise<SignedIn> {
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: signup.owner.email, password: signup.owner.password })
      .expect(200);

    expect(login.body.data.outcome).toBe('authenticated');
    return {
      token: login.body.data.accessToken as string,
      cookie: refreshCookie(login),
      enterpriseRefId: '',
    };
  }

  async function identityIdOf(email: string): Promise<number> {
    const rows: { id: string }[] = await db.query(`SELECT id FROM identities WHERE email = $1`, [
      email,
    ]);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`no identity for ${email}`);
    return Number(id);
  }

  async function liveSessionCount(identityId: number): Promise<number> {
    const rows: { count: number }[] = await db.query(
      `SELECT count(*)::int AS count FROM sessions
        WHERE identity_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [identityId],
    );
    return Number(rows[0]?.count);
  }

  describe('a refresh that names no business', () => {
    it('is refused once every employment is inactive, and kills the session with it', async () => {
      const { cookie } = await onboard(OWNER);

      // It works while the employment stands — the same request, so the
      // difference below is the employment and nothing else.
      await http().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(200);

      /*
       * Suspended by hand, deliberately NOT through the endpoint that also
       * revokes sessions. That endpoint covers the ordinary case; this is the
       * window it cannot — a session minted before the revocation commits, or a
       * removal path that never calls it — and the refresh check is the only
       * thing standing in it.
       */
      await db.query(
        `UPDATE enterprise_employees SET status = $1
          WHERE identity_id = (SELECT id FROM identities WHERE email = $2)`,
        [EmployeeStatus.Suspended, OWNER.owner.email],
      );

      const refused = await http().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(403);
      expect(refused.body.error.code).toBe('AUTH_NO_ACTIVE_EMPLOYMENT');

      // And the cookie is dead from here on, rather than being re-evaluated
      // every fifteen minutes for the rest of the week.
      const again = await http().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
      expect(again.body.error.code).toBe('AUTH_SESSION_REVOKED');
      expect(await liveSessionCount(await identityIdOf(OWNER.owner.email))).toBe(0);
    });

    it('still works for an identity that has never had an employment', async () => {
      /*
       * The case the rule must not break. No employment at all is not a
       * revocation — it is an account that has not joined a business yet, and it
       * needs a token in hand to finish doing so. The session is created
       * directly because no flow issues one for this state today, which is
       * exactly why a rule keyed on "has an active employment" would have
       * regressed silently the moment one did.
       */
      const hasher = app.get(SecretHashService);
      const refreshToken = hasher.generateOpaqueToken();
      const rows: { id: string }[] = await db.query(
        `INSERT INTO identities (email, password_hash, first_name, email_verified_at)
         VALUES ('joiner@example.test', '$argon2id$not-a-real-hash', 'Joiner', now())
         RETURNING id`,
      );
      await db.query(
        `INSERT INTO sessions (identity_id, refresh_token_hash, expires_at)
         VALUES ($1, $2, now() + interval '7 days')`,
        [Number(rows[0]?.id), hasher.hashOpaqueToken(refreshToken)],
      );

      const refreshed = await http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `refreshToken=${refreshToken}`)
        .expect(200);

      expect(refreshed.body.data.accessToken).toBeTruthy();
      expect(refreshed.body.data.enterprise).toBeNull();
    });

    it('still works for platform staff, who have no employment by design', async () => {
      await provisionPlatformAdmin(app);
      const login = await http().post('/api/v1/auth/login').send(platformAdminLogin()).expect(200);
      expect(login.body.data.enterprise).toBeNull();

      const refreshed = await http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', refreshCookie(login))
        .expect(200);

      expect(refreshed.body.data.accessToken).toBeTruthy();
      expect(refreshed.body.data.enterprise).toBeNull();
    });
  });

  describe('the cap on concurrent sessions', () => {
    it('revokes the oldest sessions and keeps the cap, without touching the new one', async () => {
      const first = await onboard(OWNER);
      const identityId = await identityIdOf(OWNER.owner.email);

      /*
       * Fill past the cap with rows older than the session onboarding just
       * created. Ages are explicit: the cap is about ORDER, and rows that all
       * took `now()` would assert against whichever the tiebreaker picked.
       */
      for (let index = 0; index < MAX_SESSIONS_PER_IDENTITY; index += 1) {
        await db.query(
          `INSERT INTO sessions (identity_id, refresh_token_hash, expires_at, created_at)
           VALUES ($1, $2, now() + interval '7 days', now() - make_interval(hours => $3::int))`,
          [identityId, `filler-${index}`, index + 1],
        );
      }
      expect(await liveSessionCount(identityId)).toBe(MAX_SESSIONS_PER_IDENTITY + 1);

      // Signing in again is what applies the cap.
      const second = await signInAgain(OWNER);

      expect(await liveSessionCount(identityId)).toBe(MAX_SESSIONS_PER_IDENTITY);
      const revoked: { refresh_token_hash: string }[] = await db.query(
        `SELECT refresh_token_hash FROM sessions
          WHERE identity_id = $1 AND revoked_at IS NOT NULL
          ORDER BY refresh_token_hash`,
        [identityId],
      );
      // The two oldest fillers, and only those.
      expect(revoked.map((row) => row.refresh_token_hash)).toEqual([
        `filler-${MAX_SESSIONS_PER_IDENTITY - 2}`,
        `filler-${MAX_SESSIONS_PER_IDENTITY - 1}`,
      ]);

      // Both real sessions still refresh: the person signing in is never the one
      // signed out, and neither is the session they came from.
      await http().post('/api/v1/auth/refresh').set('Cookie', second.cookie).expect(200);
      await http().post('/api/v1/auth/refresh').set('Cookie', first.cookie).expect(200);
    });
  });

  describe('POST /auth/logout-all', () => {
    it("signs the caller out of every device and leaves another identity's alone", async () => {
      const first = await onboard(OWNER);
      const second = await signInAgain(OWNER);
      const bystander = await onboard(OTHER);
      const identityId = await identityIdOf(OWNER.owner.email);
      expect(await liveSessionCount(identityId)).toBe(2);

      const response = await http()
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${second.token}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.sessionsRevoked).toBe(2);
      // Including the session that made the request: somebody reaching for this
      // believes a device is in the wrong hands.
      expect(refreshCookie(response)).toBe('refreshToken=');

      const dead = await http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', second.cookie)
        .expect(401);
      expect(dead.body.error.code).toBe('AUTH_SESSION_REVOKED');
      await http().post('/api/v1/auth/refresh').set('Cookie', first.cookie).expect(401);

      // The other person is still signed in. The endpoint takes no identifier at
      // all, so there is nothing through which theirs could have been named.
      await http().post('/api/v1/auth/refresh').set('Cookie', bystander.cookie).expect(200);
      expect(await liveSessionCount(await identityIdOf(OTHER.owner.email))).toBe(1);

      // Recorded, because "when did I sign everything out" is a question the
      // person asks precisely when they suspect something.
      const audited: { entity_type: string; entity_id: string; enterprise_id: string | null }[] =
        await db.query(
          `SELECT entity_type, entity_id, enterprise_id FROM audit_logs WHERE action = $1`,
          [AuditAction.Logout],
        );
      expect(audited).toHaveLength(1);
      expect(audited[0]?.entity_type).toBe(AuditEntityType.Identity);
      expect(Number(audited[0]?.entity_id)).toBe(identityId);
      // A session belongs to a person, not a business.
      expect(audited[0]?.enterprise_id).toBeNull();
    });

    it('is idempotent, so a retried request is not an error', async () => {
      const { token } = await onboard(OWNER);

      await http()
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // The access token outlives the session by design — it is stateless — so a
      // retry reaches the endpoint and must succeed having revoked nothing.
      const retry = await http()
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(retry.body.data.sessionsRevoked).toBe(0);
    });

    it('refuses an unauthenticated caller', async () => {
      const response = await http().post('/api/v1/auth/logout-all').expect(401);
      expect(response.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });
  });
});
