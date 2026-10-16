import type { MigrationInterface, QueryRunner } from 'typeorm';
import { RoleScope } from '@/shared/enums';
import { applyLateTableObjects } from '../schema/schema-objects';

/**
 * Makes `RoleScope.Staff` mean something. Backlog B3.
 *
 * `support` and `ops` have been seeded since the first migration and were
 * STRUCTURALLY ungrantable. The only grant table was `employee_roles`, whose
 * `enterprise_id` is NOT NULL behind a composite foreign key routing through
 * it, and a staff template has `enterprise_id IS NULL` — so no row pairing a
 * person with a staff role could satisfy the constraint, for any enterprise.
 * They were two rows nothing could ever point at.
 *
 * The consequence was not cosmetic: because no role join was possible, the
 * staff permission query returned EVERY staff-scoped permission to every
 * platform admin. There was no way to give one person read-only reach and
 * another connection-admin reach — the distinction the two roles exist to draw
 * was unrepresentable.
 *
 * EXPAND ONLY, and behaviour-preserving. Nothing is granted here and nothing
 * changes for an existing admin: `has_all_enterprise_access = true` still means
 * every staff permission. What this adds is the ability to say something
 * narrower, which until now could not be said at all.
 */
export class StaffRoles1758300000000 implements MigrationInterface {
  name = 'StaffRoles1758300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS staff_roles (
        id                  BIGSERIAL PRIMARY KEY,
        is_deleted          BOOLEAN NOT NULL DEFAULT false,
        created_at          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

        staff_id            BIGINT NOT NULL,
        role_id             BIGINT NOT NULL,

        -- Always 'staff'. A COLUMN rather than a constant because a foreign key
        -- can only route through one, and this is the half of the composite key
        -- that makes "staff hold only staff roles" the database's guarantee
        -- rather than a service-layer convention somebody can forget.
        role_scope          VARCHAR(30) NOT NULL DEFAULT '${RoleScope.Staff}',

        granted_by_staff_id BIGINT,

        CONSTRAINT staff_roles_scope_chk CHECK (role_scope = '${RoleScope.Staff}')
      )
    `);

    /*
     * The indexes and both foreign keys, including the composite one, live in
     * `applyLateTableObjects` so that this migration and `pnpm db:sync` produce
     * the same schema. TypeORM cannot express a partial unique index or a
     * composite foreign key, so declaring them on the entity was never an
     * option — and declaring them only here would fail schema parity.
     */
    await applyLateTableObjects((sql) => q.query(sql));

    await q.query(`
      COMMENT ON TABLE staff_roles IS
        'Which staff roles one of our own people holds. No enterprise_id: staff authority is not scoped to a business, which is what makes it staff authority.'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS staff_roles`);
    await q.query(`DROP INDEX IF EXISTS roles_id_scope_uniq`);
  }
}
