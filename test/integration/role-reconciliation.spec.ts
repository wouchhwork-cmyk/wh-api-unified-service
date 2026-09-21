import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { reconcileTenantSystemRoles } from '@/database/seed/catalogue.seed';
import { RoleRepository } from '@/database/repositories/role.repository';
import { ROLE_LEVEL, SystemRole } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * Carrying a template change to the businesses that already exist.
 *
 * THE BUG THIS FIXES (backlog B2). `instantiateSystemRoles` copies the four
 * enterprise templates into a tenant exactly once, at signup, and nothing ever
 * ran again. A permission added to the `agent` template in a later release
 * therefore reached every business created afterwards and no business created
 * before — with no error, no warning and no way to tell from the outside. Two
 * businesses on the same release could have genuinely different `agent` roles.
 *
 * Against real Postgres, because every statement involved is a set-based
 * INSERT ... SELECT or an UPDATE ... FROM over the same table twice, and the
 * thing most likely to be wrong is the join that separates a template from a
 * tenant's copy of it.
 */
describe('reconciling a tenant against the role templates', () => {
  let db: DataSource;
  let roles: RoleRepository;
  let enterpriseId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    roles = new RoleRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    await roles.instantiateSystemRoles(enterpriseId);
  });

  const templateId = async (name: string): Promise<number> => {
    const rows: { id: string }[] = await db.query(
      `SELECT id FROM roles WHERE enterprise_id IS NULL AND name = $1`,
      [name],
    );
    return Number(rows[0]?.id);
  };

  const tenantRole = async (name: string): Promise<{ id: number; level: number }> => {
    const rows: { id: string; level: number }[] = await db.query(
      `SELECT id, level FROM roles WHERE enterprise_id = $1 AND name = $2`,
      [enterpriseId, name],
    );
    return { id: Number(rows[0]?.id), level: rows[0]?.level ?? -1 };
  };

  const grantCount = async (roleId: number): Promise<number> => {
    const rows: { n: string }[] = await db.query(
      `SELECT count(*)::text AS n FROM role_permissions
        WHERE role_id = $1 AND is_deleted = false`,
      [roleId],
    );
    return Number(rows[0]?.n ?? 0);
  };

  describe('a permission added to a template after the business signed up', () => {
    it('reaches the tenant copy', async () => {
      /*
       * The exact shape of B2. `enterprise.manage` is deliberately withheld
       * from the manager template, so it is a code the tenant's manager copy
       * provably does not hold — which makes it a clean stand-in for any
       * permission a later release adds.
       */
      const template = await templateId(SystemRole.Manager);
      const tenant = await tenantRole(SystemRole.Manager);
      const before = await grantCount(tenant.id);

      await db.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permissions WHERE code = 'enterprise.manage'`,
        [template],
      );

      const result = await reconcileTenantSystemRoles(db.manager);

      expect(result.grantsAdded).toBe(1);
      expect(await grantCount(tenant.id)).toBe(before + 1);
    });

    it('does it again for nobody once everything is in step', async () => {
      // An idempotent reconciliation that always claims to have done work is
      // one nobody can use to tell whether anything changed — which is exactly
      // how a two-element [rows, count] result read as "2 rows updated".
      await reconcileTenantSystemRoles(db.manager);
      const second = await reconcileTenantSystemRoles(db.manager);

      expect(second).toEqual({ rolesAdded: 0, grantsAdded: 0, levelsCorrected: 0 });
    });
  });

  describe('a role added to the templates after the business signed up', () => {
    it('is created for the existing tenant', async () => {
      await db.query(
        `INSERT INTO roles (enterprise_id, scope, name, description, is_system, status, level)
         VALUES (NULL, 'enterprise', 'auditor', 'Reads the trail', true, 'active', 20)`,
      );

      const result = await reconcileTenantSystemRoles(db.manager);

      expect(result.rolesAdded).toBe(1);
      const created = await tenantRole('auditor');
      expect(created.level).toBe(20);
    });

    it('leaves the staff templates where they are', async () => {
      /*
       * `support` and `ops` are staff-scoped and structurally ungrantable
       * through employee_roles, whose composite FK routes through
       * enterprise_id. Copying them into a tenant would create rows that look
       * grantable and are not — which is worse than not having them.
       */
      await reconcileTenantSystemRoles(db.manager);

      const rows: { name: string }[] = await db.query(
        `SELECT name FROM roles WHERE enterprise_id = $1 AND name = ANY($2::varchar[])`,
        [enterpriseId, [SystemRole.Support, SystemRole.Ops]],
      );
      expect(rows).toEqual([]);
    });
  });

  describe('a level that has drifted', () => {
    it('is put back, because the level IS the hierarchy', async () => {
      /*
       * The only corrective (rather than additive) step, and it earns that:
       * a tenant whose `manager` outranked their `owner` would have a standing
       * escalation path, and this is the one place it could arise — a business
       * cannot edit a system role itself.
       */
      await db.query(`UPDATE roles SET level = 99 WHERE enterprise_id = $1 AND name = $2`, [
        enterpriseId,
        SystemRole.Manager,
      ]);

      const result = await reconcileTenantSystemRoles(db.manager);

      expect(result.levelsCorrected).toBe(1);
      expect((await tenantRole(SystemRole.Manager)).level).toBe(ROLE_LEVEL.Manager);
    });
  });

  describe('what it must NOT do', () => {
    it('never removes a grant the tenant has and the template does not', async () => {
      /*
       * ADDITIVE ONLY, on purpose. Taking a permission away from a live tenant
       * removes something people are using right now, and that deserves a
       * considered migration rather than a side effect of a boot-time seed.
       *
       * The consequence is stated rather than hidden: a permission withdrawn
       * from a template lingers on older tenants until somebody removes it
       * deliberately.
       */
      const tenant = await tenantRole(SystemRole.Viewer);
      await db.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permissions WHERE code = 'enterprise.manage'`,
        [tenant.id],
      );
      const before = await grantCount(tenant.id);

      await reconcileTenantSystemRoles(db.manager);

      expect(await grantCount(tenant.id)).toBe(before);
    });

    it('does not touch a role the business made for itself', async () => {
      // A custom role shares no name with a template, so the join finds no
      // partner for it — which is what keeps a business's own work safe from a
      // process whose whole job is to overwrite from a template.
      const rows: { id: string }[] = await db.query(
        `INSERT INTO roles (enterprise_id, scope, name, description, is_system, status, level)
         VALUES ($1, 'enterprise', 'Weekend cover', 'Ours', false, 'active', 35) RETURNING id`,
        [enterpriseId],
      );
      const customId = Number(rows[0]?.id);

      await reconcileTenantSystemRoles(db.manager);

      const after: { level: number; is_system: boolean }[] = await db.query(
        `SELECT level, is_system FROM roles WHERE id = $1`,
        [customId],
      );
      expect(after[0]).toMatchObject({ level: 35, is_system: false });
      expect(await grantCount(customId)).toBe(0);
    });

    it('does not reach into another business', async () => {
      const other = await seedEnterprise(db, 'Rival', 'rival');
      // Rival never had roles instantiated, so reconciliation should CREATE
      // them — and create them for Rival, not duplicate Acme's.
      await reconcileTenantSystemRoles(db.manager);

      const rivalRoles: { name: string }[] = await db.query(
        `SELECT name FROM roles WHERE enterprise_id = $1 ORDER BY name`,
        [other],
      );
      const acmeRoles: { name: string }[] = await db.query(
        `SELECT name FROM roles WHERE enterprise_id = $1 ORDER BY name`,
        [enterpriseId],
      );
      expect(rivalRoles.map((r) => r.name)).toEqual(acmeRoles.map((r) => r.name));
      expect(rivalRoles).toHaveLength(4);
    });
  });
});
