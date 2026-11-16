import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Finding the calls nobody ever learned the outcome of.
 *
 * `model_calls` was written AFTER each call returned, which looks equivalent
 * to writing it before and is not. A process dying between a model answering
 * and the insert landing leaves a call that was made, very likely billed, and
 * has no trace at all — precisely the case the table exists for. So the row
 * is now written first, in flight, and settled afterwards.
 *
 * That needs a way to find rows left in flight by a process that is no longer
 * running. Partial, because they are a handful at any moment against a table
 * that grows with every reply, and the sweep should read the handful.
 */
export class ModelCallInFlight1760600000000 implements MigrationInterface {
  name = 'ModelCallInFlight1760600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS model_calls_in_flight_idx
      ON model_calls (created_at)
      WHERE status = 'in_flight'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS model_calls_in_flight_idx`);
  }
}
