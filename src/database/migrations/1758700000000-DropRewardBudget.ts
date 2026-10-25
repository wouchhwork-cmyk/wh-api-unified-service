import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the program budget, because it could never bind.
 *
 * The design was: a program carries a money cap (`budget_minor` in
 * `budget_currency_code`), each benefit declares what it costs
 * (`budget_cost_minor`), and an award claims the sum before granting. The
 * claim itself was correct — one conditional UPDATE, atomic, with the guard in
 * the WHERE clause.
 *
 * WHAT IT COULD NOT DO IS PRICE A POINT. A money cap can only count a points
 * benefit if somebody states what a point is worth in money, and nothing ever
 * asked: no endpoint took `budgetCostMinor`, no screen offered it, and the
 * column defaulted to 0. So the claim short-circuited on a zero cost and
 * returned success, every time, for every award.
 *
 * The dev database recorded the outcome exactly: a program with
 * `budget_minor = 12` — twelve paise — granted awards with `spent_minor` still
 * 0, and `skipped_budget` was never written once across the whole table. A
 * control that cannot fail is worse than no control, because the screen
 * promised a ceiling the engine would never apply.
 *
 * Capping spend is a real requirement and will come back, but it has to answer
 * the question this design skipped: points and money are separate quantities
 * and the system must not pretend one converts to the other without being told
 * the rate. Until that exists, nothing here claims to limit anything.
 *
 * SAFE TO DROP, verified rather than assumed: no row carries a non-zero
 * `budget_cost_minor`, no `spent_minor` is non-zero, and no award holds the
 * `skipped_budget` status, so no awarded value is explained by these columns.
 * `down()` restores the shape but NOT the numbers — the budgets themselves are
 * the only thing lost, and they bounded nothing.
 */
export class DropRewardBudget1758700000000 implements MigrationInterface {
  name = 'DropRewardBudget1758700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE reward_programs
        DROP COLUMN IF EXISTS budget_minor,
        DROP COLUMN IF EXISTS budget_currency_code,
        DROP COLUMN IF EXISTS spent_minor
    `);

    await q.query(`
      ALTER TABLE reward_rule_benefits
        DROP COLUMN IF EXISTS budget_cost_minor
    `);
  }

  /*
   * Shape only. Every restored column comes back at its default — NULL for the
   * caps, 0 for the counters — which is what they held in practice anyway.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE reward_programs
        ADD COLUMN IF NOT EXISTS budget_minor         BIGINT,
        ADD COLUMN IF NOT EXISTS budget_currency_code CHAR(3),
        ADD COLUMN IF NOT EXISTS spent_minor          BIGINT NOT NULL DEFAULT 0
    `);

    await q.query(`
      ALTER TABLE reward_rule_benefits
        ADD COLUMN IF NOT EXISTS budget_cost_minor BIGINT NOT NULL DEFAULT 0
    `);
  }
}
