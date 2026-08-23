import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { IdentityRepository } from '@/database/repositories/identity.repository';
import { LOGIN_LOCK_DURATION_MS, MAX_FAILED_LOGINS } from '@/shared/constants';
import { createTestDataSource, truncateTenantData } from './db.harness';

/**
 * Login throttling state, which is one SQL statement and therefore untestable
 * anywhere but against real Postgres.
 *
 * Two defects motivated these, and both hurt the legitimate account holder
 * rather than the attacker:
 *
 *   - the lock was RE-ARMED on every wrong guess, so anyone who knew an address
 *     could keep its owner locked out indefinitely just by guessing on a timer;
 *   - the counter was never cleared when a lock expired, so a served-out account
 *     sat permanently at the threshold and the next single typo re-locked it.
 */
describe('login lockout', () => {
  let db: DataSource;
  let identities: IdentityRepository;
  let identityId: number;

  const fail = async (): Promise<void> => {
    await identities.recordFailedLogin(identityId, MAX_FAILED_LOGINS, LOGIN_LOCK_DURATION_MS);
  };

  const read = async (): Promise<{ count: number; lockedUntil: Date | null }> => {
    const rows: { failed_login_count: number; locked_until: Date | null }[] = await db.query(
      `SELECT failed_login_count, locked_until FROM identities WHERE id = $1`,
      [identityId],
    );
    return {
      count: Number(rows[0]?.failed_login_count),
      lockedUntil: rows[0]?.locked_until ?? null,
    };
  };

  beforeAll(async () => {
    db = await createTestDataSource();
    identities = new IdentityRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    const rows: { id: string }[] = await db.query(
      `INSERT INTO identities (email, password_hash, first_name)
       VALUES ('someone@example.test','$argon2id$not-a-real-hash','Someone') RETURNING id`,
    );
    identityId = Number(rows[0]?.id);
  });

  it('counts up without locking until the threshold', async () => {
    for (let attempt = 1; attempt < MAX_FAILED_LOGINS; attempt += 1) {
      await fail();
      const state = await read();
      expect(state.count).toBe(attempt);
      expect(state.lockedUntil).toBeNull();
    }
  });

  it('locks on the threshold attempt', async () => {
    for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt += 1) await fail();

    const state = await read();
    expect(state.count).toBe(MAX_FAILED_LOGINS);
    expect(state.lockedUntil).not.toBeNull();
    expect(state.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('does NOT extend a lock that is already running', async () => {
    for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt += 1) await fail();
    const locked = await read();

    // Ten more guesses against a locked account. The old statement pushed
    // locked_until forward on every one of them, which is a denial of service
    // against the account holder that costs the attacker nothing.
    for (let attempt = 0; attempt < 10; attempt += 1) await fail();
    const after = await read();

    expect(after.lockedUntil).toStrictEqual(locked.lockedUntil);
  });

  it('starts a fresh window once a lock has expired', async () => {
    for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt += 1) await fail();
    await db.query(
      `UPDATE identities SET locked_until = now() - interval '1 second' WHERE id = $1`,
      [identityId],
    );

    await fail();
    const state = await read();

    /*
     * The count restarts at one and the stale lock is cleared. Before this, the
     * count stayed at MAX_FAILED_LOGINS after the lock expired, so the very next
     * typo re-locked the account for another fifteen minutes — permanently, for
     * anyone whose password was simply hard to type.
     */
    expect(state.count).toBe(1);
    expect(state.lockedUntil).toBeNull();
  });

  it('clears the count and the lock on a successful login', async () => {
    for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt += 1) await fail();

    await identities.recordSuccessfulLogin(identityId);
    const state = await read();

    expect(state.count).toBe(0);
    expect(state.lockedUntil).toBeNull();
  });
});
