import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the DATABASE the backstop for tenant isolation on `role_permissions`.
 *
 * `employee_roles` has been protected by its own schema from the start: its FK
 * is `(role_id, enterprise_id) → roles (id, enterprise_id)`, so a grant cannot
 * name another tenant's role even if a query forgets its predicate.
 * `role_permissions` carried a single-column FK to `roles (id)` and no
 * `enterprise_id` at all, so isolation there rested ENTIRELY on the
 * `enterprise_id = $1` predicate at the two write sites. Both are correct
 * today. This stops that being the only thing standing between a future
 * refactor and a cross-tenant grant.
 *
 * THE COLUMN IS NULLABLE, and that is not an oversight. `role_permissions`
 * serves two kinds of role: a tenant's, and the platform's TEMPLATES, which
 * live with `enterprise_id IS NULL` (six of them today). A NOT NULL here would
 * have no legal value to put on a template's grants and would break the
 * catalogue seed on the first boot after deploy.
 *
 * What that costs, said plainly: a FK with a NULL column is satisfied without
 * being checked (MATCH SIMPLE), so a write that omits `enterprise_id`
 * ENTIRELY still escapes the constraint. What this closes is the case that
 * matters — a grant naming a role belonging to a DIFFERENT tenant is now
 * impossible rather than merely prevented by a predicate somebody has to
 * remember. The predicate at both write sites still earns its place.
 *
 * EXPAND, in the order that keeps every step safe on a live table:
 *   1. add the column nullable, which blocks nothing;
 *   2. backfill it from the parent role, which is the only possible answer;
 *   3. add the composite FK, and drop the single-column one it supersedes.
 *
 * The old constraint is dropped rather than kept beside the new one: both
 * reference the same parent with the same cascade, so keeping it would mean two
 * constraints enforcing one rule and a reader wondering which is load-bearing.
 */
export class RolePermissionsTenantKey1758500000000 implements MigrationInterface {
  name = 'RolePermissionsTenantKey1758500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS enterprise_id BIGINT`);

    /*
     * The role is the only source of truth for which tenant a grant belongs to,
     * which is exactly why the column looked redundant until it became a
     * constraint. A template's role has no tenant, so its grants keep NULL —
     * the join below simply finds nothing to copy.
     */
    await q.query(`
      UPDATE role_permissions rp
         SET enterprise_id = r.enterprise_id
        FROM roles r
       WHERE r.id = rp.role_id
         AND rp.enterprise_id IS NULL
    `);

    /*
     * Grants whose role no longer exists at all. The single-column FK should
     * have cascaded these away; any that survive would fail the new constraint
     * and block the deploy, and a grant pointing at nothing grants nothing.
     */
    await q.query(`
      DELETE FROM role_permissions rp
       WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = rp.role_id)
    `);

    /*
     * IDEMPOTENT, because a FRESH database already has these: the initial
     * migration creates the column and `applyPostTableObjects` adds both
     * constraints before this ever runs. Dropping first makes one statement
     * correct for both a new install and an existing one, rather than needing
     * to know which it is looking at.
     */
    await q.query(`
      ALTER TABLE role_permissions
        DROP CONSTRAINT IF EXISTS role_permissions_role_fk,
        DROP CONSTRAINT IF EXISTS role_permissions_enterprise_fk,
        ADD CONSTRAINT role_permissions_enterprise_fk
            FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT role_permissions_role_fk
            FOREIGN KEY (role_id, enterprise_id) REFERENCES roles (id, enterprise_id)
            ON DELETE CASCADE
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS role_permissions_enterprise_idx
      ON role_permissions (enterprise_id)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS role_permissions_enterprise_idx`);
    await q.query(`
      ALTER TABLE role_permissions
        DROP CONSTRAINT IF EXISTS role_permissions_role_fk,
        DROP CONSTRAINT IF EXISTS role_permissions_enterprise_fk,
        ADD CONSTRAINT role_permissions_role_fk
            FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
    `);
    await q.query(`ALTER TABLE role_permissions DROP COLUMN IF EXISTS enterprise_id`);
  }
}
