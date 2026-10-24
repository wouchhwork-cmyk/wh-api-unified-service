import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The guarantees the audit trail CLAIMS, asserted rather than assumed.
 *
 * Every one of these was documented as true before it was. The entity and the
 * repository both stated that `UPDATE` and `DELETE` were revoked from the
 * application role; the REVOKE that would have done it is guarded on the
 * application role differing from the migration role, which is false on every
 * developer machine and anywhere `DB_APP_ROLE` is unset. Measured on the dev
 * database, the role held UPDATE, DELETE and TRUNCATE, and both statements
 * succeeded against a real row.
 *
 * A tamper tripwire attached to a row the ordinary role can edit is not a
 * tripwire. These tests exist so that can never quietly become true again.
 */
describe('the audit trail is append-only in the database', () => {
  let db: DataSource;
  let enterpriseId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    await db.query(
      `INSERT INTO audit_logs (enterprise_id, actor_kind, action, entity_type, entity_id)
       VALUES ($1, 'employee', 'created', 'reward_program', 1)`,
      [enterpriseId],
    );
  });

  it('refuses an UPDATE, whatever the row says', async () => {
    await expect(
      db.query(`UPDATE audit_logs SET action = 'tampered' WHERE enterprise_id = $1`, [
        enterpriseId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a DELETE', async () => {
    await expect(
      db.query(`DELETE FROM audit_logs WHERE enterprise_id = $1`, [enterpriseId]),
    ).rejects.toThrow(/append-only/);
  });

  /**
   * The specific edit an attacker would want, and the specific one the old
   * comment promised was impossible: rewriting WHO did something.
   */
  it('refuses to have the actor rewritten', async () => {
    await expect(
      db.query(`UPDATE audit_logs SET actor_kind = 'system', actor_employee_id = NULL`),
    ).rejects.toThrow(/append-only/);
  });

  /**
   * The tripwire only means something because of the tests above. On a table
   * the application can edit, `updated_at = created_at` says nothing at all.
   */
  it('leaves updated_at equal to created_at, which is now a guarantee', async () => {
    const rows: { untouched: boolean }[] = await db.query(
      `SELECT (updated_at = created_at) AS untouched FROM audit_logs`,
    );
    expect(rows).not.toHaveLength(0);
    for (const row of rows) expect(row.untouched).toBe(true);
  });

  /**
   * TRUNCATE is NOT blocked, and that is a deliberate bargain rather than an
   * oversight: a row trigger cannot see it, the harness needs it between
   * cases, and anyone able to TRUNCATE can drop the trigger anyway. Pinned so
   * the limit is stated rather than discovered.
   */
  it('does not pretend to stop a TRUNCATE', async () => {
    await expect(db.query(`TRUNCATE audit_logs`)).resolves.not.toThrow();
  });
});
