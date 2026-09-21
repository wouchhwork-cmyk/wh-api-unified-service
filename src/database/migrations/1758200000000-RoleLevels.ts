import type { MigrationInterface, QueryRunner } from 'typeorm';
import { MIN_ROLE_LEVEL, ROLE_LEVEL, SYSTEM_ROLE_LEVELS } from '@/shared/enums';

/**
 * Gives a role a position in a hierarchy, which until now did not exist.
 *
 * There was no level, rank or seniority anywhere in the schema. The entire
 * "who may hand out what" rule was one string comparison against the name
 * `owner`, in the invite path — correct as far as it went, and the only thing
 * standing between a manager and full control of the business.
 *
 * That is survivable while there is no way to create or edit a role. It stops
 * being survivable the moment there is, which is what this work adds. So the
 * level lands FIRST, before any of the endpoints that would need it.
 *
 * EXPAND / BACKFILL / CONSTRAIN, in that order, so the column is never briefly
 * NOT NULL over rows that have no value yet:
 *
 *   1. add it nullable
 *   2. fill every existing row from its name
 *   3. make it NOT NULL and range-checked
 *
 * Safe to deploy before the code that reads it: a nullable-then-filled column
 * that nothing queries is inert.
 */
export class RoleLevels1758200000000 implements MigrationInterface {
  name = 'RoleLevels1758200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE roles ADD COLUMN IF NOT EXISTS level SMALLINT`);

    /*
     * Existing rows, by name. Every role in the database today is one of the
     * six seeded ones or a per-tenant copy of one of the four enterprise
     * templates, so the name is a complete key — but the fallback below does
     * not assume that.
     */
    for (const [name, level] of Object.entries(SYSTEM_ROLE_LEVELS)) {
      await q.query(`UPDATE roles SET level = $1 WHERE name = $2 AND level IS NULL`, [level, name]);
    }

    /*
     * Anything unrecognised lands at the bottom, not the top.
     *
     * There should be nothing here. If there is, the safe direction is
     * unambiguous: a role that accidentally outranks the owner can hand out
     * everything, while one that accidentally outranks nothing merely cannot
     * hand out anything, and somebody will notice and fix it.
     */
    await q.query(`UPDATE roles SET level = $1 WHERE level IS NULL`, [MIN_ROLE_LEVEL]);

    await q.query(`ALTER TABLE roles ALTER COLUMN level SET NOT NULL`);
    await q.query(`
      ALTER TABLE roles ADD CONSTRAINT roles_level_chk
      CHECK (level BETWEEN ${MIN_ROLE_LEVEL} AND ${ROLE_LEVEL.Owner})
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_level_chk`);
    await q.query(`ALTER TABLE roles DROP COLUMN IF EXISTS level`);
  }
}
