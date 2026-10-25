import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A business gets a second name: the one its customers will see.
 *
 * The same split `reward_programs` already makes, for the same reason, one
 * level up. `name` is what the business is called in its own records —
 * free text, and `slug` beside it is the unique, URL-safe handle. Neither was
 * ever chosen with a customer in mind: a business signs up as "Acme Foods Pvt
 * Ltd" because that is what is on the paperwork, and that is not what it wants
 * to say at the top of a thank-you message.
 *
 * Until now there was no way to say anything else. The messages this service
 * sends address a customer in the business's name, and the only name available
 * was the legal one.
 *
 * `display_name` is deliberately the opposite of `name` in every respect that
 * matters:
 *
 *   - **NOT unique.** Two businesses may both greet customers as "Acme".
 *     Telling them apart is what `slug` and `ref_id` are for; a label shown to
 *     a customer has no such job.
 *   - **No format rules.** It is marketing copy — emoji, punctuation, mixed
 *     script, whatever the business wants to be called. Policing it would be
 *     deciding how somebody may present themselves to their own customers.
 *   - **Nullable, and NOT backfilled from `name`.** Copying the legal name in
 *     would make every existing business look as though somebody had chosen to
 *     show customers their registered entity, and there would be no way
 *     afterwards to tell a real choice from the backfill. Unset means unset,
 *     and a caller with something to render falls back to `name`.
 *
 * BOUNDED ANYWAY, because "no checks" cannot mean "no limit": 160 characters,
 * matching `reward_programs.display_name`. An unbounded text column reachable
 * from a request body is a way to put a megabyte in a row, and the cost of
 * saying so now is nothing next to discovering the absence later.
 *
 * ADDITIVE AND NULLABLE, so this deploys ahead of the code that reads it with
 * no window in which either half is wrong.
 */
export class EnterpriseDisplayName1759500000000 implements MigrationInterface {
  name = 'EnterpriseDisplayName1759500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS display_name VARCHAR(160)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE enterprises DROP COLUMN IF EXISTS display_name`);
  }
}
