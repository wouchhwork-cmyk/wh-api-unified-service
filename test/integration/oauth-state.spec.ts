import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createTestDataSource, truncateTenantData } from './db.harness';

/**
 * The OAuth `state` parameter is single-use — enforced in SQL, so a mock would
 * prove nothing.
 *
 * This matters more than it looks. `state` is the only CSRF defence in an OAuth
 * redirect, and a merely SIGNED state stays valid for its whole lifetime: the
 * callback URL sits in browser history, in logs, and in a Referer header, and
 * replaying it would run the whole connection flow again under somebody else's
 * business.
 */
describe('oauth state is spendable exactly once', () => {
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
    await db.query(`DELETE FROM oauth_states`);
    const enterprise: { id: string }[] = await db.query(
      `INSERT INTO enterprises (name, slug, email) VALUES ('Acme','acme','a@acme.test') RETURNING id`,
    );
    enterpriseId = Number(enterprise[0]?.id);
  });

  /** The same conditional UPDATE the repository issues. */
  async function consume(nonce: string): Promise<{ enterprise_id: string }[]> {
    const result: unknown = await db.query(
      `UPDATE oauth_states
          SET consumed_at = now(), updated_at = now()
        WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > now() AND is_deleted = false
       RETURNING enterprise_id`,
      [nonce],
    );
    // UPDATE ... RETURNING comes back as [rows, affectedCount].
    return (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as {
      enterprise_id: string;
    }[];
  }

  async function mint(nonce: string, expiresInMs = 600_000): Promise<void> {
    await db.query(
      `INSERT INTO oauth_states (nonce, enterprise_id, expires_at)
            VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
      [nonce, enterpriseId, String(expiresInMs)],
    );
  }

  it('returns the business the first time and nothing the second', async () => {
    await mint('nonce-single-use');

    const first = await consume('nonce-single-use');
    expect(first).toHaveLength(1);
    expect(Number(first[0]?.enterprise_id)).toBe(enterpriseId);

    // The replay. Same nonce, still inside its window, and it must fail.
    const second = await consume('nonce-single-use');
    expect(second).toHaveLength(0);
  });

  it('refuses an expired state', async () => {
    await mint('nonce-expired', -1_000);
    expect(await consume('nonce-expired')).toHaveLength(0);
  });

  it('refuses an unknown nonce', async () => {
    expect(await consume('nonce-never-minted')).toHaveLength(0);
  });

  it('lets exactly one of two simultaneous callbacks win', async () => {
    await mint('nonce-race');

    /*
     * The reason consumption is ONE conditional UPDATE rather than a read then a
     * write. Read-then-write would let both of these pass the check before
     * either wrote, and both would proceed — which is the replay this exists to
     * prevent, arriving by accident instead of by malice.
     */
    const [a, b] = await Promise.all([consume('nonce-race'), consume('nonce-race')]);
    expect(a.length + b.length).toBe(1);
  });

  it('cannot hold two rows for one nonce', async () => {
    await mint('nonce-unique');
    // The uniqueness is the guarantee, not a convention the service is trusted
    // to keep.
    await expect(mint('nonce-unique')).rejects.toThrow();
  });

  it('cannot name an employee belonging to another business', async () => {
    const other: { id: string }[] = await db.query(
      `INSERT INTO enterprises (name, slug, email) VALUES ('Other','other','o@other.test') RETURNING id`,
    );
    const identity: { id: string }[] = await db.query(
      `INSERT INTO identities (email, password_hash, first_name)
            VALUES ('e@other.test','h','E') RETURNING id`,
    );
    const employee: { id: string }[] = await db.query(
      `INSERT INTO enterprise_employees (identity_id, enterprise_id) VALUES ($1,$2) RETURNING id`,
      [Number(identity[0]?.id), Number(other[0]?.id)],
    );

    // The composite foreign key makes this unrepresentable rather than merely
    // discouraged: the employee exists, but not in THIS business.
    await expect(
      db.query(
        `INSERT INTO oauth_states (nonce, enterprise_id, employee_id, expires_at)
              VALUES ('nonce-cross-tenant', $1, $2, now() + interval '10 minutes')`,
        [enterpriseId, Number(employee[0]?.id)],
      ),
    ).rejects.toThrow();
  });
});
