import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { EnterpriseEmployeeRepository } from '@/database/repositories/enterprise-employee.repository';
import { SessionRepository } from '@/database/repositories/session.repository';
import { MAX_SESSIONS_PER_IDENTITY } from '@/shared/constants';
import { EmployeeKind, EmployeeStatus } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The two halves of session lifecycle that are SQL and therefore untestable
 * anywhere but against real Postgres: the cap on concurrent sessions, and the
 * employment counts that decide whether a refresh is still allowed.
 *
 * Both exist because of the same defect. Every login inserted a `sessions` row
 * and revoked nothing, so the live refresh tokens per person were bounded only by
 * how often they signed in — and a refresh that named no business re-checked
 * nothing at all, so somebody suspended kept minting access tokens for the seven
 * days their cookie lasted.
 */
describe('session lifecycle', () => {
  let db: DataSource;
  let sessions: SessionRepository;
  let employees: EnterpriseEmployeeRepository;

  beforeAll(async () => {
    db = await createTestDataSource();
    sessions = new SessionRepository(db);
    employees = new EnterpriseEmployeeRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await truncateTenantData(db);
  });

  async function insertIdentity(email: string): Promise<number> {
    const rows: { id: string }[] = await db.query(
      `INSERT INTO identities (email, password_hash, first_name)
       VALUES ($1, '$argon2id$not-a-real-hash', 'Someone') RETURNING id`,
      [email],
    );
    return Number(rows[0]?.id);
  }

  /**
   * One session row, with its age and its expiry stated rather than defaulted —
   * the cap is about ORDER, and a test that let every row take `now()` would be
   * asserting against whichever one the tiebreaker happened to pick.
   */
  async function insertSession(
    identityId: number,
    hash: string,
    options: { ageMinutes: number; expiresInMinutes?: number; revoked?: boolean },
  ): Promise<number> {
    const rows: { id: string }[] = await db.query(
      `INSERT INTO sessions (identity_id, refresh_token_hash, expires_at, created_at, revoked_at)
       VALUES ($1, $2,
               now() + make_interval(mins => $3::int),
               now() - make_interval(mins => $4::int),
               CASE WHEN $5::boolean THEN now() ELSE NULL END)
       RETURNING id`,
      [
        identityId,
        hash,
        options.expiresInMinutes ?? 7 * 24 * 60,
        options.ageMinutes,
        options.revoked ?? false,
      ],
    );
    return Number(rows[0]?.id);
  }

  /** Newest first, which is the order the cap keeps. */
  async function liveHashes(identityId: number): Promise<string[]> {
    const rows: { refresh_token_hash: string }[] = await db.query(
      `SELECT refresh_token_hash FROM sessions
        WHERE identity_id = $1
          AND revoked_at IS NULL
          AND expires_at > now()
          AND is_deleted = false
        ORDER BY created_at DESC, id DESC`,
      [identityId],
    );
    return rows.map((row) => row.refresh_token_hash);
  }

  describe('the cap on concurrent sessions', () => {
    it('does nothing while the identity is under the cap', async () => {
      const identityId = await insertIdentity('under@example.test');
      for (let index = 0; index < MAX_SESSIONS_PER_IDENTITY; index += 1) {
        await insertSession(identityId, `hash-${index}`, { ageMinutes: index });
      }

      const revoked = await sessions.revokeBeyondNewest(identityId, MAX_SESSIONS_PER_IDENTITY);

      expect(revoked).toBe(0);
      expect(await liveHashes(identityId)).toHaveLength(MAX_SESSIONS_PER_IDENTITY);
    });

    it('revokes the OLDEST sessions first, and keeps exactly the cap', async () => {
      const identityId = await insertIdentity('over@example.test');
      // Three past the cap, ages ascending, so `hash-0` is the newest and the
      // last three are the ones that must go.
      const total = MAX_SESSIONS_PER_IDENTITY + 3;
      for (let index = 0; index < total; index += 1) {
        await insertSession(identityId, `hash-${index}`, { ageMinutes: index });
      }

      const revoked = await sessions.revokeBeyondNewest(identityId, MAX_SESSIONS_PER_IDENTITY);

      expect(revoked).toBe(3);
      const live = await liveHashes(identityId);
      expect(live).toHaveLength(MAX_SESSIONS_PER_IDENTITY);
      // The newest survives and the three oldest are gone — the direction that
      // matters, because reversing it would sign somebody out of the session
      // they are using and leave three stale ones alive.
      expect(live[0]).toBe('hash-0');
      expect(live).not.toContain(`hash-${total - 1}`);
      expect(live).not.toContain(`hash-${total - 2}`);
      expect(live).not.toContain(`hash-${total - 3}`);
    });

    it('is idempotent — a second pass revokes nothing more', async () => {
      const identityId = await insertIdentity('twice@example.test');
      for (let index = 0; index < MAX_SESSIONS_PER_IDENTITY + 2; index += 1) {
        await insertSession(identityId, `hash-${index}`, { ageMinutes: index });
      }

      await sessions.revokeBeyondNewest(identityId, MAX_SESSIONS_PER_IDENTITY);
      const second = await sessions.revokeBeyondNewest(identityId, MAX_SESSIONS_PER_IDENTITY);

      expect(second).toBe(0);
      expect(await liveHashes(identityId)).toHaveLength(MAX_SESSIONS_PER_IDENTITY);
    });

    it('never counts an expired or already-revoked row against the cap', async () => {
      const identityId = await insertIdentity('dead-rows@example.test');
      // The cap's worth of LIVE sessions, plus a pile of rows nobody can present.
      for (let index = 0; index < MAX_SESSIONS_PER_IDENTITY; index += 1) {
        await insertSession(identityId, `live-${index}`, { ageMinutes: index });
      }
      await insertSession(identityId, 'expired', { ageMinutes: 1, expiresInMinutes: -1 });
      await insertSession(identityId, 'revoked', { ageMinutes: 1, revoked: true });

      const revoked = await sessions.revokeBeyondNewest(identityId, MAX_SESSIONS_PER_IDENTITY);

      // Counting the dead rows would have evicted two working sessions in favour
      // of two nobody can use.
      expect(revoked).toBe(0);
      expect(await liveHashes(identityId)).toHaveLength(MAX_SESSIONS_PER_IDENTITY);
    });

    it("leaves another identity's sessions alone", async () => {
      const mine = await insertIdentity('mine@example.test');
      const theirs = await insertIdentity('theirs@example.test');
      for (let index = 0; index < MAX_SESSIONS_PER_IDENTITY + 2; index += 1) {
        await insertSession(mine, `mine-${index}`, { ageMinutes: index });
        await insertSession(theirs, `theirs-${index}`, { ageMinutes: index });
      }

      await sessions.revokeBeyondNewest(mine, MAX_SESSIONS_PER_IDENTITY);

      expect(await liveHashes(mine)).toHaveLength(MAX_SESSIONS_PER_IDENTITY);
      expect(await liveHashes(theirs)).toHaveLength(MAX_SESSIONS_PER_IDENTITY + 2);
    });
  });

  describe('sign out everywhere', () => {
    it("revokes every live session for one identity and nobody else's", async () => {
      const mine = await insertIdentity('signout@example.test');
      const theirs = await insertIdentity('bystander@example.test');
      for (let index = 0; index < 3; index += 1) {
        await insertSession(mine, `mine-${index}`, { ageMinutes: index });
        await insertSession(theirs, `theirs-${index}`, { ageMinutes: index });
      }

      const revoked = await sessions.revokeAllForIdentity(mine);

      expect(revoked).toBe(3);
      expect(await liveHashes(mine)).toEqual([]);
      expect(await liveHashes(theirs)).toHaveLength(3);
    });

    it('is idempotent, so a retried request is not an error', async () => {
      const identityId = await insertIdentity('retry@example.test');
      await insertSession(identityId, 'only', { ageMinutes: 0 });

      expect(await sessions.revokeAllForIdentity(identityId)).toBe(1);
      expect(await sessions.revokeAllForIdentity(identityId)).toBe(0);
    });
  });

  describe('employment standing', () => {
    async function addEmployment(
      identityId: number,
      enterpriseId: number,
      status: EmployeeStatus,
    ): Promise<void> {
      await db.query(
        `INSERT INTO enterprise_employees (identity_id, enterprise_id, employee_kind, status)
         VALUES ($1, $2, $3, $4)`,
        [identityId, enterpriseId, EmployeeKind.Business, status],
      );
    }

    it('reports nothing at all for an identity that never had an employment', async () => {
      const identityId = await insertIdentity('nobody@example.test');

      // The case the refresh rule must NOT refuse: standing was never granted,
      // which is a fresh account or platform staff — not a revocation.
      expect(await employees.countStandingForIdentity(identityId)).toEqual({
        employments: 0,
        active: 0,
      });
    });

    it('reports an active employment as standing', async () => {
      const identityId = await insertIdentity('active@example.test');
      const enterpriseId = await seedEnterprise(db, 'Acme Coffee', 'acme-coffee');
      await addEmployment(identityId, enterpriseId, EmployeeStatus.Active);

      expect(await employees.countStandingForIdentity(identityId)).toEqual({
        employments: 1,
        active: 1,
      });
    });

    it('reports a suspended employment as recorded but not active', async () => {
      const identityId = await insertIdentity('suspended@example.test');
      const enterpriseId = await seedEnterprise(db, 'Acme Coffee', 'acme-coffee');
      await addEmployment(identityId, enterpriseId, EmployeeStatus.Suspended);

      // This is the shape refresh refuses: on the record, and nowhere active.
      expect(await employees.countStandingForIdentity(identityId)).toEqual({
        employments: 1,
        active: 0,
      });
    });

    it('reports an invitation never accepted as recorded but not active', async () => {
      const identityId = await insertIdentity('invited@example.test');
      const enterpriseId = await seedEnterprise(db, 'Acme Coffee', 'acme-coffee');
      await addEmployment(identityId, enterpriseId, EmployeeStatus.Invited);

      expect(await employees.countStandingForIdentity(identityId)).toEqual({
        employments: 1,
        active: 0,
      });
    });

    it('still reports standing when one business suspended them and another did not', async () => {
      const identityId = await insertIdentity('twobusinesses@example.test');
      const first = await seedEnterprise(db, 'Acme Coffee', 'acme-coffee');
      const second = await seedEnterprise(db, 'Bakery Ltd', 'bakery-ltd');
      await addEmployment(identityId, first, EmployeeStatus.Suspended);
      await addEmployment(identityId, second, EmployeeStatus.Active);

      // Suspension is per business and an identity is global, so one business
      // switching somebody off must not end their day at another.
      expect(await employees.countStandingForIdentity(identityId)).toEqual({
        employments: 2,
        active: 1,
      });
    });

    it('does not count an employment in a deleted business as active', async () => {
      const identityId = await insertIdentity('gone@example.test');
      const enterpriseId = await seedEnterprise(db, 'Acme Coffee', 'acme-coffee');
      await addEmployment(identityId, enterpriseId, EmployeeStatus.Active);
      await db.query(`UPDATE enterprises SET is_deleted = true WHERE id = $1`, [enterpriseId]);

      // Matches listActiveByIdentity, which joins the enterprise the same way —
      // so login and refresh cannot disagree about what standing is.
      expect(await employees.countStandingForIdentity(identityId)).toEqual({
        employments: 1,
        active: 0,
      });
    });
  });
});
