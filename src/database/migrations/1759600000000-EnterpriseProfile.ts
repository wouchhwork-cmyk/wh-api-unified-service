import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What a business tells its customers about itself: a description, the links
 * it wants them to follow, and how to reach a person.
 *
 * All three are things a customer READS. None of them is queried, joined,
 * aggregated or filtered on — the whole profile is loaded with the business
 * and rendered — so they are stored as they are used rather than normalised
 * into tables that nothing would ever join.
 *
 * WHY JSONB AND NOT TWO CHILD TABLES. The case for `enterprise_links` and
 * `enterprise_contacts` is that a row-per-link is the orthodox shape and gets
 * per-field constraints for free. The case against is what those tables would
 * actually buy here: there is no query that selects links across businesses,
 * no foreign key pointing AT a link, and no part of the system that updates
 * one link without rewriting the list. What they would add is two more tables
 * to tenant-scope, two more deletes to remember, and an ordering column to
 * maintain by hand — ordering that matters, because the order is the
 * business's own answer to "what matters most".
 *
 * The honest cost of this choice, stated rather than discovered: the database
 * does not police the shape. A row could hold `[{"label": 1}]` and Postgres
 * would accept it. The schema in `settings.contract.ts` is therefore the only
 * thing standing between a request body and the column — which is why that
 * file validates the URL by PARSING it and refuses a label that is secretly
 * an address, rather than checking a length and hoping.
 *
 * NOT NULL DEFAULT '[]' rather than nullable, so there is one empty: callers
 * read a list and get a list. On Postgres 11+ a constant default is a
 * metadata-only change, so this does not rewrite the table.
 *
 * `about` is nullable, because "has not written one" and "wrote nothing" are
 * genuinely different states and only one of them is worth rendering.
 *
 * Additive throughout, so this deploys ahead of the code that reads it.
 */
export class EnterpriseProfile1759600000000 implements MigrationInterface {
  name = 'EnterpriseProfile1759600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS about TEXT`);
    await q.query(
      `ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await q.query(
      `ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS contacts JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE enterprises DROP COLUMN IF EXISTS contacts`);
    await q.query(`ALTER TABLE enterprises DROP COLUMN IF EXISTS links`);
    await q.query(`ALTER TABLE enterprises DROP COLUMN IF EXISTS about`);
  }
}
