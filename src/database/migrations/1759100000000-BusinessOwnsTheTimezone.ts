import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One timezone and one currency per business, held by the business, and
 * neither of them guessed.
 *
 * Both lived on `reward_programs`, taken at creation and copied no further.
 * So two programs in one business could disagree about when Tuesday starts
 * and about what money means, nothing reconciled them, and a cap period
 * derived from one would silently differ from the same period derived from
 * the other.
 *
 * `enterprises.timezone` already existed — `NOT NULL DEFAULT 'Asia/Kolkata'`
 * — and `schema.md` already described the program column as "defaults from
 * enterprise". The default was copied once at creation and then drifted on its
 * own, which is the usual way a derived value quietly becomes an independent
 * one. `enterprises.currency_code` is new and follows the same rule.
 *
 * THE COLUMNS GO rather than being kept in sync. A copy that must be kept in
 * sync is a copy that will not be.
 *
 * A BENEFIT MAY STILL NAME ITS OWN CURRENCY. A promotion paying in something
 * other than the business's usual is a real case, so `grant_currency` keeps
 * its optional `currencyCode`. What it no longer does is fall back to a
 * per-programme copy: unstated now means the business's.
 *
 * WHAT THIS CHANGES FOR EXISTING DATA, stated rather than discovered: a
 * program whose timezone differed from its business's now resolves periods in
 * the business's. On this database both programs hold `Asia/Calcutta` and so
 * do their enterprises, so nothing moves. The currency backfill below takes
 * each business's most-used programme currency precisely so nothing moves
 * elsewhere either.
 */
export class BusinessOwnsTheTimezone1759100000000 implements MigrationInterface {
  name = 'BusinessOwnsTheTimezone1759100000000';

  public async up(q: QueryRunner): Promise<void> {
    /*
     * NULLABLE FIRST, backfilled, then defaulted — the expand half of
     * expand/contract. Adding it NOT NULL with a default would rewrite every
     * row under an exclusive lock and give businesses that already work in
     * another currency the wrong one.
     */
    await q.query(`ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS currency_code CHAR(3)`);

    /*
     * Inherit what the business's programmes already used, so no existing
     * configuration changes meaning. `MODE()` picks the most common where a
     * business has several; ties resolve arbitrarily and are a pre-existing
     * disagreement this migration is ending rather than creating.
     *
     * A business with no currency-bearing programme is left NULL: it has
     * never expressed a currency, and inventing one for it is exactly what
     * this column exists to avoid.
     */
    await q.query(`
      UPDATE enterprises e
         SET currency_code = p.code
        FROM (
          SELECT enterprise_id,
                 MODE() WITHIN GROUP (ORDER BY default_currency_code) AS code
            FROM reward_programs
           WHERE default_currency_code IS NOT NULL AND is_deleted = false
           GROUP BY enterprise_id
        ) p
       WHERE p.enterprise_id = e.id
         AND e.currency_code IS NULL
    `);

    /*
     * AND IT STAYS NULLABLE. NULL means "this business has not chosen one",
     * which is a state worth being able to represent.
     *
     * Defaulting to 'INR' was the first instinct and it is the wrong one: it
     * would mean no business is ever unconfigured, so a rule that grants money
     * without naming a currency would quietly pay in rupees to a business that
     * had never said anything about rupees. Silently picking somebody's
     * currency for them is worse than refusing and asking.
     *
     * The timezone is deliberately NOT treated this way. Every business has a
     * "today" whether or not it has thought about it, and the reporting day
     * has to resolve to something — so that column keeps its NOT NULL and its
     * default. Money does not have a safe default.
     */

    /*
     * AND THE TIMEZONE LOSES ITS DEFAULT TOO.
     *
     * `NOT NULL DEFAULT 'Asia/Kolkata'` meant every business that never
     * thought about it was silently given one — so a business in London had
     * "once a day" resetting at half past six in the evening, correctly, for
     * entirely the wrong reason, with nothing on any screen to reveal it.
     * Signup no longer asks and no longer defaults.
     *
     * EXISTING VALUES ARE KEPT. Every business that has one chose it or has
     * been running on it; clearing them would break working configuration to
     * make a point. Only the default and the NOT NULL go, so "not chosen" is
     * representable from here on.
     */
    await q.query(`
      ALTER TABLE enterprises
        ALTER COLUMN timezone DROP DEFAULT,
        ALTER COLUMN timezone DROP NOT NULL
    `);

    await q.query(`
      ALTER TABLE reward_programs
        DROP COLUMN IF EXISTS timezone,
        DROP COLUMN IF EXISTS default_currency_code
    `);
  }

  /*
   * Shape only. The per-programme values do not come back — they were the
   * thing this migration decided should not exist, and each is recoverable
   * from the business that owns the programme.
   */
  public async down(q: QueryRunner): Promise<void> {
    /* A business with no timezone gets the old default back, or the NOT NULL
     * below cannot be restored. */
    await q.query(`UPDATE enterprises SET timezone = 'Asia/Kolkata' WHERE timezone IS NULL`);
    await q.query(`
      ALTER TABLE enterprises
        ALTER COLUMN timezone SET DEFAULT 'Asia/Kolkata',
        ALTER COLUMN timezone SET NOT NULL
    `);
    await q.query(`
      ALTER TABLE reward_programs
        ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
        ADD COLUMN IF NOT EXISTS default_currency_code CHAR(3)
    `);
    await q.query(`ALTER TABLE enterprises DROP COLUMN IF EXISTS currency_code`);
  }
}
