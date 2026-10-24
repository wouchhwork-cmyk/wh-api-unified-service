import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * What the dashboard counts, and what it deliberately does not.
 *
 * The exclusions are the part worth pinning: a figure that silently includes
 * the wrong movement reads like a bug in a feature that is working.
 */
describe('the reward dashboard', () => {
  let db: DataSource;
  let enterpriseId: number;
  let programId: number;
  let ruleId: number;
  let customerId: number;
  let pointsWalletId: number;

  const VALUE_QUERY = `
    SELECT a.program_id AS "programId",
           w.wallet_kind AS "walletKind",
           COALESCE(SUM(l.amount), 0)::text AS net
      FROM reward_ledger_entries l
      JOIN reward_awards a ON a.id = l.award_id AND a.enterprise_id = l.enterprise_id
      JOIN reward_wallets w ON w.id = l.wallet_id AND w.enterprise_id = l.enterprise_id
     WHERE l.enterprise_id = $1 AND a.is_deleted = false
       AND l.entry_kind NOT IN ('convert_out', 'adjust')
     GROUP BY a.program_id, w.wallet_kind`;

  beforeAll(async () => {
    db = await createTestDataSource();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Dash Co', 'dash-co');

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

    const [wallet] = await db.query(
      `INSERT INTO reward_wallets (enterprise_id, customer_id, wallet_kind)
       VALUES ($1, $2, 'points') RETURNING id`,
      [enterpriseId, customerId],
    );
    pointsWalletId = Number(wallet.id);
  });

  async function award(sourceRefId: number, status = 'granted'): Promise<number> {
    const [row] = await db.query(
      `INSERT INTO reward_awards
              (enterprise_id, program_id, rule_id, rule_version, customer_id,
               source_ref_kind, source_ref_id, status, occurred_at_utc)
       VALUES ($1, $2, $3, 1, $4, 'message', $5, $6, now()) RETURNING id`,
      [enterpriseId, programId, ruleId, customerId, sourceRefId, status],
    );
    return Number(row.id);
  }

  const entry = (awardId: number, kind: string, amount: number, key: string): Promise<unknown> =>
    db.query(
      `INSERT INTO reward_ledger_entries
              (enterprise_id, wallet_id, entry_kind, amount, balance_after,
               award_id, idempotency_key, occurred_at_utc)
       VALUES ($1, $2, $3, $4, 0, $5, $6, now())`,
      [enterpriseId, pointsWalletId, kind, amount, awardId, key],
    );

  it('counts what a program granted', async () => {
    await entry(await award(1), 'earn', 20, 'k1');
    await entry(await award(2), 'earn', 30, 'k2');

    const [row] = await db.query(VALUE_QUERY, [enterpriseId]);
    expect(row.net).toBe('50');
  });

  /** Net, not gross: a clawed-back award stops counting. */
  it('subtracts a reversal', async () => {
    const id = await award(3);
    await entry(id, 'earn', 20, 'k3');
    await entry(id, 'reversal', -20, 'k3r');

    const [row] = await db.query(VALUE_QUERY, [enterpriseId]);
    expect(row.net).toBe('0');
  });

  /**
   * THE DISTORTION THIS EXCLUSION EXISTS FOR.
   *
   * convert_out is the customer spending their own points, not the program
   * taking them away. Counting it made a program whose rule converts points
   * report a NEGATIVE points figure — points it never granted — while the
   * program that actually granted them looked untouched.
   */
  it('ignores points the customer spent on a conversion', async () => {
    const earned = await award(4);
    await entry(earned, 'earn', 50, 'k4');

    const converted = await award(5);
    await entry(converted, 'convert_out', -30, 'k5');

    const [row] = await db.query(VALUE_QUERY, [enterpriseId]);
    expect(row.net).toBe('50');
  });

  /** A manual adjustment is a support gesture, not a rule's performance. */
  it('ignores a manual adjustment', async () => {
    const id = await award(6);
    await entry(id, 'earn', 20, 'k6');
    await entry(id, 'adjust', 500, 'k6a');

    const [row] = await db.query(VALUE_QUERY, [enterpriseId]);
    expect(row.net).toBe('20');
  });

  /**
   * int8 exceeds what a JS number holds safely, so the driver hands back text.
   * The figure stays a string all the way to the client rather than being
   * silently rounded on the way through.
   */
  it('returns the total as a string, not a number', async () => {
    await entry(await award(7), 'earn', 20, 'k7');
    const [row] = await db.query(VALUE_QUERY, [enterpriseId]);
    expect(typeof row.net).toBe('string');
  });

  it('groups awards by status, refusals included', async () => {
    await award(8, 'granted');
    await award(9, 'skipped_cap');
    await award(10, 'skipped_cap');

    const rows = await db.query(
      `SELECT status, COUNT(*)::int AS awards
         FROM reward_awards WHERE enterprise_id = $1 AND is_deleted = false
        GROUP BY status ORDER BY status`,
      [enterpriseId],
    );
    const byStatus = Object.fromEntries(
      rows.map((r: { status: string; awards: number }) => [r.status, r.awards]),
    );
    expect(byStatus.granted).toBe(1);
    expect(byStatus.skipped_cap).toBe(2);
  });
});
