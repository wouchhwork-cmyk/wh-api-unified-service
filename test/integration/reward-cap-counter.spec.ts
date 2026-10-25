import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The frequency cap, against real Postgres.
 *
 * This is the one guarantee that cannot be tested with a mock: a mocked
 * repository would happily let two concurrent claims both succeed, which is
 * precisely the bug the statement exists to prevent.
 *
 * The claim is one INSERT ... ON CONFLICT DO UPDATE ... WHERE used < cap. There
 * is no window between a check and a write because there is no separate check.
 */
describe('the reward cap counter', () => {
  let db: DataSource;
  let enterpriseId: number;
  let programId: number;
  let ruleId: number;
  let customerId: number;

  const CLAIM = `
    INSERT INTO reward_cap_counters
            (enterprise_id, program_id, rule_id, customer_id, period_key, used, cap)
    VALUES ($1, $2, $3, $4, $5, 1, $6)
    ON CONFLICT (enterprise_id, rule_id, customer_id, period_key)
    DO UPDATE SET used = reward_cap_counters.used + 1
          WHERE reward_cap_counters.used < reward_cap_counters.cap
    RETURNING used`;

  beforeAll(async () => {
    db = await createTestDataSource();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Cap Co', 'cap-co');

    const [program] = await db.query(
      `INSERT INTO reward_programs (enterprise_id, name)
       VALUES ($1, 'Social Rewards') RETURNING id`,
      [enterpriseId],
    );
    programId = Number(program.id);

    const [rule] = await db.query(
      `INSERT INTO reward_rules (enterprise_id, program_id, trigger_kind, cap_scope, cap_count)
       VALUES ($1, $2, 'story_mention', 'week', 1) RETURNING id`,
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

  const claim = (periodKey: string, cap = 1): Promise<{ used: number }[]> =>
    db.query(CLAIM, [enterpriseId, programId, ruleId, customerId, periodKey, cap]);

  it('grants the first claim in a period', async () => {
    const rows = await claim('2026-W43');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.used)).toBe(1);
  });

  it('refuses the second claim once the cap is reached', async () => {
    await claim('2026-W43');
    const second = await claim('2026-W43');
    expect(second).toHaveLength(0);
  });

  it('grants again in the next period', async () => {
    await claim('2026-W43');
    const nextWeek = await claim('2026-W44');
    expect(nextWeek).toHaveLength(1);
  });

  it('counts up to a cap above one, then stops', async () => {
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await claim('2026-W43', 3));
    }
    const granted = results.filter((rows) => rows.length > 0);
    expect(granted).toHaveLength(3);
  });

  /**
   * THE RACE THIS EXISTS FOR.
   *
   * Ten simultaneous claims against a cap of one. Read-then-check-then-write
   * would let several through — all ten read `used = 0`, all ten pass, all ten
   * write. Exactly one must win.
   *
   * This is the shape of CVE-2026-31824, where an ORM made it worse by
   * flushing an absolute value instead of an increment, so the writers
   * overwrote one another rather than accumulating.
   */
  it('lets exactly one of ten concurrent claims through', async () => {
    const attempts = Array.from({ length: 10 }, () => claim('2026-W43'));
    const results = await Promise.all(attempts);
    const winners = results.filter((rows) => rows.length > 0);

    expect(winners).toHaveLength(1);

    const [row] = await db.query(
      `SELECT used FROM reward_cap_counters WHERE rule_id = $1 AND customer_id = $2`,
      [ruleId, customerId],
    );
    expect(Number(row.used)).toBe(1);
  });

  it('lets exactly three of twenty concurrent claims through for a cap of three', async () => {
    const attempts = Array.from({ length: 20 }, () => claim('2026-W43', 3));
    const results = await Promise.all(attempts);
    expect(results.filter((rows) => rows.length > 0)).toHaveLength(3);
  });

  /**
   * A DOUBLE RELEASE MUST NOT HAND OUT A FREE SLOT.
   *
   * GREATEST(used - 1, 0) rather than a bare decrement. Without the floor, two
   * reversals of one award would leave used at -1, and the next claim would
   * find room that was never there.
   */
  it('floors the release at zero', async () => {
    await claim('2026-W43');
    const release = `UPDATE reward_cap_counters SET used = GREATEST(used - 1, 0)
                      WHERE enterprise_id = $1 AND rule_id = $2
                        AND customer_id = $3 AND period_key = $4`;
    await db.query(release, [enterpriseId, ruleId, customerId, '2026-W43']);
    await db.query(release, [enterpriseId, ruleId, customerId, '2026-W43']);

    const [row] = await db.query(`SELECT used FROM reward_cap_counters WHERE rule_id = $1`, [
      ruleId,
    ]);
    expect(Number(row.used)).toBe(0);
  });

  /** Two customers do not share a slot, however alike their activity. */
  it('keeps each customer to their own counter', async () => {
    const [other] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source)
       VALUES ($1, 'Ravi', 'instagram') RETURNING id`,
      [enterpriseId],
    );
    await claim('2026-W43');
    const theirs = await db.query(CLAIM, [
      enterpriseId,
      programId,
      ruleId,
      Number(other.id),
      '2026-W43',
      1,
    ]);
    expect(theirs).toHaveLength(1);
  });
});
