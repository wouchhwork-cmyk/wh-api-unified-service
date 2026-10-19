import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  createTestDataSource,
  returningRows,
  seedEnterprise,
  truncateTenantData,
} from './db.harness';

/**
 * The program budget: claimed atomically, and given back when an award is
 * undone — including an award that never granted.
 */
describe('the reward program budget', () => {
  let db: DataSource;
  let enterpriseId: number;
  let programId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Budget Co', 'budget-co');
    const [program] = await db.query(
      `INSERT INTO reward_programs
              (enterprise_id, name, timezone, budget_minor, budget_currency_code)
       VALUES ($1, 'Rewards', 'UTC', 1000, 'INR') RETURNING id`,
      [enterpriseId],
    );
    programId = Number(program.id);
  });

  /*
   * returningRows, because an UPDATE ... RETURNING hands back the tuple
   * [rows, affected] while an INSERT hands back a flat array — a test that
   * ignores that measures the shape rather than the behaviour.
   */
  const claim = async (cost: number): Promise<unknown[]> =>
    returningRows(
      await db.query(
        `UPDATE reward_programs
          SET spent_minor = spent_minor + $3
        WHERE id = $1 AND enterprise_id = $2 AND is_deleted = false
          AND (budget_minor IS NULL OR spent_minor + $3 <= budget_minor)
      RETURNING spent_minor AS "spentMinor"`,
        [programId, enterpriseId, cost],
      ),
    );

  const spent = async (): Promise<number> => {
    const [row] = await db.query(`SELECT spent_minor AS s FROM reward_programs WHERE id = $1`, [
      programId,
    ]);
    return Number(row.s);
  };

  it('allows spending up to the cap', async () => {
    expect(await claim(600)).toHaveLength(1);
    expect(await claim(400)).toHaveLength(1);
    expect(await spent()).toBe(1000);
  });

  it('refuses the claim that would exceed the cap', async () => {
    await claim(900);
    expect(await claim(200)).toHaveLength(0);
    expect(await spent()).toBe(900);
  });

  /**
   * Concurrent claims cannot jointly overspend. Read-then-check-then-write
   * would let both through — each reads 0 spent, each sees room for 600.
   */
  it('lets concurrent claims overspend by nothing', async () => {
    const results = await Promise.all([claim(600), claim(600)]);
    expect(results.filter((rows) => rows.length > 0)).toHaveLength(1);
    expect(await spent()).toBe(600);
  });

  /** A double release must not create budget that never existed. */
  it('floors the release at zero', async () => {
    await claim(100);
    await db.query(
      `UPDATE reward_programs SET spent_minor = GREATEST(spent_minor - 100, 0) WHERE id = $1`,
      [programId],
    );
    await db.query(
      `UPDATE reward_programs SET spent_minor = GREATEST(spent_minor - 100, 0) WHERE id = $1`,
      [programId],
    );
    expect(await spent()).toBe(0);
  });

  /**
   * A NULL budget is uncapped, not zero. A program with no budget set must not
   * refuse its first award.
   */
  it('treats an absent budget as uncapped', async () => {
    await db.query(`UPDATE reward_programs SET budget_minor = NULL WHERE id = $1`, [programId]);
    expect(await claim(999_999)).toHaveLength(1);
  });
});
