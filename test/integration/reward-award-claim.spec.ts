import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * Two guarantees on the award row, against real Postgres.
 *
 * Both are index-shaped rather than code-shaped, which is the point: a mocked
 * repository would accept what the database refuses.
 */
describe('reward award claiming', () => {
  let db: DataSource;
  let enterpriseId: number;
  let programId: number;
  let ruleId: number;
  let customerId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Claim Co', 'claim-co');

    const [program] = await db.query(
      `INSERT INTO reward_programs (enterprise_id, name)
       VALUES ($1, 'Rewards') RETURNING id`,
      [enterpriseId],
    );
    programId = Number(program.id);

    const [rule] = await db.query(
      `INSERT INTO reward_rules (enterprise_id, program_id, trigger_kind)
       VALUES ($1, $2, 'story_mention') RETURNING id`,
      [enterpriseId, programId],
    );
    ruleId = Number(rule.id);

    const [customer] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source)
       VALUES ($1, 'Priya', 'instagram') RETURNING id`,
      [enterpriseId],
    );
    customerId = Number(customer.id);
  });

  const createAward = (sourceRefId: number, status = 'held'): Promise<{ id: string }[]> =>
    db.query(
      `INSERT INTO reward_awards
              (enterprise_id, program_id, rule_id, rule_version, customer_id,
               source_ref_kind, source_ref_id, status, held_until, occurred_at_utc)
       VALUES ($1, $2, $3, 1, $4, 'message', $5, $6, now() - interval '1 hour', now())
       ON CONFLICT (enterprise_id, rule_id, customer_id, source_ref_kind, source_ref_id)
         WHERE is_deleted = false
       DO NOTHING
       RETURNING id`,
      [enterpriseId, programId, ruleId, customerId, sourceRefId, status],
    );

  /**
   * EXACTLY-ONCE PER SOURCE EVENT.
   *
   * A redelivered webhook, a replayed backfill and a retried job are the normal
   * case under at-least-once delivery, not an error — so the second insert
   * returns nothing rather than raising.
   */
  it('creates one award per source event, however many times it arrives', async () => {
    const first = await createAward(900);
    const second = await createAward(900);
    const third = await createAward(900);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(0);

    const [count] = await db.query(
      `SELECT COUNT(*)::int AS n FROM reward_awards WHERE source_ref_id = 900`,
    );
    expect(count.n).toBe(1);
  });

  it('allows separate awards for separate source events', async () => {
    expect(await createAward(901)).toHaveLength(1);
    expect(await createAward(902)).toHaveLength(1);
  });

  /**
   * THE DOUBLE-GRANT RACE.
   *
   * Two instances run the grant sweep, and both list the same held award. The
   * claim is SELECT ... FOR UPDATE SKIP LOCKED inside the per-award
   * transaction, so the second gets nothing and moves on rather than doing the
   * work and failing on a downstream unique index.
   */
  it('lets only one of two concurrent workers claim a held award', async () => {
    const [award] = await createAward(903);
    const awardId = Number(award!.id);

    const claim = `SELECT id FROM reward_awards
                    WHERE id = $1 AND enterprise_id = $2
                      AND status = 'held' AND is_deleted = false
                    FOR UPDATE SKIP LOCKED`;

    const workerA = db.transaction(async (managerA) => {
      const mine = await managerA.query(claim, [awardId, enterpriseId]);
      // Hold the lock while the other worker tries, as real work would.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return mine.length;
    });

    const workerB = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return db.transaction(async (managerB) => {
        const mine = await managerB.query(claim, [awardId, enterpriseId]);
        return mine.length;
      });
    })();

    const [gotA, gotB] = await Promise.all([workerA, workerB]);
    expect(gotA + gotB).toBe(1);
  });

  /** An award already granted is not claimable, so a late tick does nothing. */
  it('does not claim an award that is no longer held', async () => {
    const [award] = await createAward(904, 'granted');
    const rows = await db.query(
      `SELECT id FROM reward_awards
        WHERE id = $1 AND status = 'held' FOR UPDATE SKIP LOCKED`,
      [Number(award!.id)],
    );
    expect(rows).toHaveLength(0);
  });

  /**
   * ONE REVERSAL PER LEDGER ENTRY, EVER.
   *
   * Re-submitting the same compensation is a no-op via the idempotency key; a
   * DIFFERENT compensation against an already-reversed entry is an error,
   * because swallowing it as a duplicate would hide a double reversal.
   */
  it('refuses a second reversal of one ledger entry', async () => {
    const [wallet] = await db.query(
      `INSERT INTO reward_wallets (enterprise_id, customer_id, wallet_kind)
       VALUES ($1, $2, 'points') RETURNING id`,
      [enterpriseId, customerId],
    );
    const walletId = Number(wallet.id);

    const [earn] = await db.query(
      `INSERT INTO reward_ledger_entries
              (enterprise_id, wallet_id, entry_kind, amount, balance_after,
               idempotency_key, occurred_at_utc)
       VALUES ($1, $2, 'earn', 20, 20, 'k-earn', now()) RETURNING id`,
      [enterpriseId, walletId],
    );

    const reversal = (key: string): Promise<unknown> =>
      db.query(
        `INSERT INTO reward_ledger_entries
                (enterprise_id, wallet_id, entry_kind, amount, balance_after,
                 idempotency_key, reverses_entry_id, occurred_at_utc)
         VALUES ($1, $2, 'reversal', -20, 0, $3, $4, now())`,
        [enterpriseId, walletId, key, Number(earn.id)],
      );

    await reversal('k-rev-1');
    await expect(reversal('k-rev-2')).rejects.toThrow();
  });

  /** The ledger refuses an UPDATE outright. Corrections are new rows. */
  it('is append-only in the database, not merely by policy', async () => {
    const [wallet] = await db.query(
      `INSERT INTO reward_wallets (enterprise_id, customer_id, wallet_kind)
       VALUES ($1, $2, 'points') RETURNING id`,
      [enterpriseId, customerId],
    );
    await db.query(
      `INSERT INTO reward_ledger_entries
              (enterprise_id, wallet_id, entry_kind, amount, balance_after,
               idempotency_key, occurred_at_utc)
       VALUES ($1, $2, 'earn', 10, 10, 'k-append', now())`,
      [enterpriseId, Number(wallet.id)],
    );

    await expect(
      db.query(`UPDATE reward_ledger_entries SET amount = 999 WHERE idempotency_key = 'k-append'`),
    ).rejects.toThrow(/append-only/);

    await expect(
      db.query(`DELETE FROM reward_ledger_entries WHERE idempotency_key = 'k-append'`),
    ).rejects.toThrow(/append-only/);
  });
});
