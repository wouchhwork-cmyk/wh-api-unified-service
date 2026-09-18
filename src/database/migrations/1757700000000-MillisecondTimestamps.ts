import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every timestamptz column drops to millisecond precision.
 *
 * The reasoning is in `src/database/timestamp-precision.ts`, in short: nothing
 * in this application can READ a microsecond — the driver hands timestamps to a
 * JS `Date` and the API prints them with `toISOString()`, both millisecond — so
 * the extra digits were invisible everywhere except inside SQL comparisons,
 * where they made keyset cursors wrong. Ascending listings repeated the cursor
 * row; descending ones silently skipped every row sharing that millisecond.
 *
 * Storing only what can be read makes that whole class of bug unrepresentable,
 * and leaves plain b-tree indexes usable — truncating in each query instead
 * would forfeit the index on exactly the hot tables that need one.
 *
 * WRITTEN AS A LOOP over the catalogue rather than 121 hand-listed statements.
 * The invariant is "every timestamptz in this schema is millisecond", and a
 * loop says that, stays correct if a column is added before this runs, and is
 * idempotent — a second run finds nothing left to do. `format('%I')` quotes
 * both identifiers, so nothing is concatenated into SQL.
 *
 * NOT reversible in the sense that matters: `down()` restores the column TYPE,
 * but the three digits it rounded away are gone from the data. That is
 * acceptable here and would not be after launch, which is the argument for
 * doing it now — the tables are empty, so the rewrite is free, and every
 * ALTER ... TYPE below takes an ACCESS EXCLUSIVE lock and rewrites the table.
 * On a populated database this must be scheduled, not deployed casually.
 */
export class MillisecondTimestamps1757700000000 implements MigrationInterface {
  name = 'MillisecondTimestamps1757700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      DECLARE target record;
      BEGIN
        FOR target IN
          SELECT c.table_name, c.column_name
            FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_schema = c.table_schema
             AND t.table_name = c.table_name
           WHERE c.table_schema = 'public'
             AND t.table_type = 'BASE TABLE'
             AND c.data_type = 'timestamp with time zone'
             AND c.datetime_precision <> 3
        LOOP
          EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz(3)',
            target.table_name, target.column_name
          );
        END LOOP;
      END $$;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      DECLARE target record;
      BEGIN
        FOR target IN
          SELECT c.table_name, c.column_name
            FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_schema = c.table_schema
             AND t.table_name = c.table_name
           WHERE c.table_schema = 'public'
             AND t.table_type = 'BASE TABLE'
             AND c.data_type = 'timestamp with time zone'
             AND c.datetime_precision = 3
        LOOP
          EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz',
            target.table_name, target.column_name
          );
        END LOOP;
      END $$;
    `);
  }
}
