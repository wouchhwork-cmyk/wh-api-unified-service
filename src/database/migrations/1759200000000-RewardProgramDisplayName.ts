import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A programme gets a second name: the one customers will see.
 *
 * `name` is the INTERNAL identifier. It is unique per business, case
 * insensitively (`reward_programs_name_uniq` on `(enterprise_id,
 * lower(name))`), because its job is to let somebody in the business say
 * which programme they mean without ambiguity. "Monsoon loyalty v2" is a
 * perfectly good internal name and a terrible thing to show a customer.
 *
 * `display_name` is the opposite in every respect, and deliberately:
 *
 *   - **NOT unique.** Two programmes may both greet customers as "Rewards".
 *     Which one awarded is a question for the ledger, not the label.
 *   - **No format rules.** It is marketing copy. Emoji, punctuation, mixed
 *     script, whatever the business wants to call it in front of its
 *     customers — none of that is ours to police.
 *   - **Nullable.** Nothing shows it to an end user yet, so requiring one
 *     would be demanding a decision for a surface that does not exist. Until
 *     it is set, a client with something to render falls back to `name`.
 *
 * WHAT IT IS STILL BOUNDED BY, because "no checks" cannot mean "no limit": a
 * length. An unbounded text column reachable from a request body is a way to
 * put a megabyte in a row, and the cost of saying 160 characters now is
 * nothing next to discovering the absence later.
 *
 * Existing rows are left NULL rather than backfilled from `name`. Copying the
 * internal name into the customer-facing one would make every existing
 * programme look as though somebody had chosen to show customers an internal
 * label — and there would be no way afterwards to tell a real choice from the
 * backfill.
 */
export class RewardProgramDisplayName1759200000000 implements MigrationInterface {
  name = 'RewardProgramDisplayName1759200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE reward_programs ADD COLUMN IF NOT EXISTS display_name VARCHAR(160)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE reward_programs DROP COLUMN IF EXISTS display_name`);
  }
}
