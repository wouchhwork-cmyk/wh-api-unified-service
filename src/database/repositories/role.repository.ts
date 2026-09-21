import { Injectable } from '@nestjs/common';
import {
  EmployeeStatus,
  EnterpriseFeatureStatus,
  highestRoleLevel,
  PermissionScope,
  PermissionStatus,
  RoleScope,
  RoleStatus,
  SystemRole,
} from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface RoleRow {
  readonly id: number;
  /** The only identifier that crosses the API boundary. */
  readonly refId: string;
  readonly name: string;
  readonly scope: RoleScope;
  /** Higher means more authority. See ROLE_LEVEL. */
  readonly level: number;
  /** Seeded by us: grantable, never editable by the business. */
  readonly isSystem: boolean;
  /**
   * What the role grants. Carried on the BASE row, not only on the detailed
   * one, because `mayAssignRole` needs it — a grant is as much a subset
   * decision as a definition is.
   */
  readonly permissionCodes: string[];
}

/** A role with everything a role editor needs to show it. */
export interface RoleDetailRow extends RoleRow {
  readonly description: string | null;
  readonly permissionCodes: string[];
  /** How many people currently hold it. Archiving one that is in use is not silent. */
  readonly holderCount: number;
}

/** One assignable permission, as the catalogue defines it. */
export interface PermissionCatalogueRow {
  readonly code: string;
  readonly description: string | null;
  /** NULL when the permission is not gated on a feature at all. */
  readonly featureKey: string | null;
  /** Whether this enterprise currently holds that feature. */
  readonly featureActive: boolean;
}

@Injectable()
export class RoleRepository extends BaseRepository {
  /**
   * Instantiates the enterprise's own system roles by COPYING the NULL-enterprise
   * templates, together with their permission grants.
   *
   * This copy is not incidental: employee_roles routes both foreign keys through
   * enterprise_id, so a role with enterprise_id NULL is structurally
   * unassignable. Every enterprise therefore needs its own rows (schema.md §8).
   *
   * Runs inside the signup transaction. Two statements, both set-based, so a new
   * enterprise costs two round trips rather than one per role.
   */
  async instantiateSystemRoles(enterpriseId: number): Promise<Map<string, number>> {
    const { rows: created } = await this.mutate<{ id: number; name: string }>(
      `INSERT INTO roles (enterprise_id, scope, name, description, is_system, status, level)
       SELECT $1, t.scope, t.name, t.description, true, $2, t.level
         FROM roles t
        WHERE t.enterprise_id IS NULL
          AND t.scope = $3
          AND t.is_system = true
          AND t.is_deleted = false
       RETURNING id, name`,
      [this.requireEnterprise(enterpriseId), RoleStatus.Active, RoleScope.Enterprise],
    );

    if (created.length > 0) {
      // Copy each template's grants onto the new role of the same name.
      await this.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT new_role.id, trp.permission_id
           FROM roles new_role
           JOIN roles template
             ON template.enterprise_id IS NULL
            AND template.name = new_role.name
            AND template.scope = new_role.scope
            AND template.is_system = true
            AND template.is_deleted = false
           JOIN role_permissions trp
             ON trp.role_id = template.id
            AND trp.is_deleted = false
          WHERE new_role.enterprise_id = $1
            AND new_role.is_system = true
            AND new_role.is_deleted = false
         ON CONFLICT DO NOTHING`,
        [enterpriseId],
      );
    }

    return new Map(created.map((role) => [role.name, role.id]));
  }

  /**
   * Every role this business has, with what each one grants.
   *
   * One query rather than a role query plus a grant query per role: a role
   * editor lists them all with their permissions, and the N+1 version is the
   * obvious way to write it.
   */
  async listDetailed(enterpriseId: number): Promise<RoleDetailRow[]> {
    return this.query<RoleDetailRow>(
      `SELECT r.id,
              r.ref_id AS "refId",
              r.name,
              r.scope,
              r.level,
              r.is_system AS "isSystem",
              r.description,
              COALESCE(
                array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}'
              ) AS "permissionCodes",
              (SELECT count(*)::int FROM employee_roles er
                WHERE er.role_id = r.id AND er.enterprise_id = r.enterprise_id
                  AND er.is_deleted = false) AS "holderCount"
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = false
         LEFT JOIN permissions p ON p.id = rp.permission_id AND p.is_deleted = false
        WHERE r.enterprise_id = $1 AND r.is_deleted = false AND r.status = $2
        GROUP BY r.id
        ORDER BY r.level DESC, r.is_system DESC, r.name`,
      [this.requireEnterprise(enterpriseId), RoleStatus.Active],
    );
  }

  /**
   * The permissions a business may put in a role, and whether each is live.
   *
   * ENTERPRISE-SCOPED ONLY. A staff code in a tenant's role editor would be a
   * toggle that can never do anything — `features.decide` is ours, not theirs.
   *
   * The feature state travels with each row rather than filtering the list.
   * A business whose comment feature lapsed should still SEE the comment
   * permissions, greyed out and explained; hiding them would make a role that
   * already grants them look corrupt, and would hide what buying the feature
   * back would restore.
   */
  async listAssignablePermissions(enterpriseId: number): Promise<PermissionCatalogueRow[]> {
    return this.query<PermissionCatalogueRow>(
      `SELECT p.code,
              p.description,
              f.key AS "featureKey",
              COALESCE(ef.status = $2, false) AS "featureActive"
         FROM permissions p
         LEFT JOIN features f ON f.id = p.feature_id AND f.is_deleted = false
         LEFT JOIN enterprise_features ef
                ON ef.feature_id = p.feature_id AND ef.enterprise_id = $1
               AND ef.is_deleted = false
        WHERE p.is_deleted = false
          AND p.status = $3
          AND p.scope <> $4
        ORDER BY p.code`,
      [
        this.requireEnterprise(enterpriseId),
        EnterpriseFeatureStatus.Active,
        PermissionStatus.Active,
        PermissionScope.Staff,
      ],
    );
  }

  /** A role by refId whatever its status, for editing and archiving. */
  async findAnyByRefId(enterpriseId: number, refId: string): Promise<RoleDetailRow | null> {
    const rows = await this.query<RoleDetailRow>(
      `SELECT r.id, r.ref_id AS "refId", r.name, r.scope, r.level,
              r.is_system AS "isSystem", r.description,
              COALESCE(
                array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}'
              ) AS "permissionCodes",
              (SELECT count(*)::int FROM employee_roles er
                WHERE er.role_id = r.id AND er.enterprise_id = r.enterprise_id
                  AND er.is_deleted = false) AS "holderCount"
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = false
         LEFT JOIN permissions p ON p.id = rp.permission_id AND p.is_deleted = false
        WHERE r.enterprise_id = $1 AND r.ref_id = $2 AND r.is_deleted = false
        GROUP BY r.id`,
      [this.requireEnterprise(enterpriseId), refId],
    );
    return rows[0] ?? null;
  }

  /**
   * Creates a role the business owns.
   *
   * `is_system` is hard-coded false and is not a parameter. A business minting
   * a row that claims to be one of ours would be immune to editing — the
   * service refuses to edit system roles — and would be overwritten by the
   * template reconciliation if the name ever collided.
   */
  async createRole(input: {
    enterpriseId: number;
    name: string;
    description: string | null;
    level: number;
  }): Promise<{ id: number; refId: string }> {
    const { rows } = await this.mutate<{ id: number; refId: string }>(
      `INSERT INTO roles (enterprise_id, scope, name, description, is_system, status, level)
       VALUES ($1, $2, $3, $4, false, $5, $6)
       RETURNING id, ref_id AS "refId"`,
      [
        this.requireEnterprise(input.enterpriseId),
        RoleScope.Enterprise,
        input.name,
        input.description,
        RoleStatus.Active,
        input.level,
      ],
    );
    const created = rows[0];
    if (!created) throw new Error('role insert returned nothing');
    return created;
  }

  async updateRole(input: {
    enterpriseId: number;
    roleId: number;
    name: string;
    description: string | null;
    level: number;
  }): Promise<number> {
    const { affected } = await this.mutate(
      `UPDATE roles
          SET name = $3, description = $4, level = $5, updated_at = now()
        WHERE enterprise_id = $1 AND id = $2 AND is_deleted = false AND is_system = false
        RETURNING id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.roleId,
        input.name,
        input.description,
        input.level,
      ],
    );
    return affected;
  }

  /**
   * Replaces a role's permissions with exactly this set.
   *
   * DELETE-THEN-INSERT rather than a diff, and hard delete rather than soft.
   * `role_permissions` is a join table with no history worth keeping — the
   * audit trail records who changed a role and to what — and a soft-deleted row
   * would collide with the unique index the next time the same permission was
   * granted back. Runs inside the caller's transaction, so a role is never
   * briefly permissionless to a concurrent request.
   */
  async replaceRolePermissions(
    enterpriseId: number,
    roleId: number,
    permissionCodes: readonly string[],
  ): Promise<void> {
    /*
     * THE TENANT IS NAMED EVEN THOUGH THE CALLER ALREADY RESOLVED THE ROLE.
     *
     * Both callers reach this only after `findAnyByRefId(enterpriseId, refId)`
     * or `createRole(enterpriseId, ...)`, so the id is already proven to belong
     * to the business. That makes the clause redundant today and it stays,
     * because "an id alone is not authority" is the rule this schema is built
     * on — a role id is a bigint, and the next caller may be a background job,
     * an import, or a bulk edit that resolved it some other way. The same
     * reasoning put the tenant clause on attachment refresh, which is the one
     * place attachments are mutable at all.
     */
    await this.query(
      `DELETE FROM role_permissions rp
        USING roles r
        WHERE rp.role_id = r.id AND r.id = $2 AND r.enterprise_id = $1`,
      [this.requireEnterprise(enterpriseId), roleId],
    );
    if (permissionCodes.length === 0) return;

    await this.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id
         FROM roles r
         /*
          * ACTIVE and NON-STAFF, checked here as well as by the subset rule
          * upstream. This is the last thing between a code and an enterprise
          * role: a staff-only code such as features.decide in a tenant's role
          * would be a permission the business was never meant to hold, and the
          * subset rule only keeps it out for as long as the subset rule is
          * whole. A retired code is refused for the same reason.
          */
         JOIN permissions p ON p.code = ANY($3::varchar[])
                           AND p.is_deleted = false
                           AND p.status = $4
                           AND p.scope <> $5
        WHERE r.id = $2 AND r.enterprise_id = $1 AND r.is_deleted = false
       ON CONFLICT DO NOTHING`,
      [
        this.requireEnterprise(enterpriseId),
        roleId,
        [...permissionCodes],
        PermissionStatus.Active,
        PermissionScope.Staff,
      ],
    );
  }

  /**
   * Archives a role. NOT a delete.
   *
   * The grants pointing at it stay, so the record of who held what survives —
   * and `listForEnterprise` filters on `status = active`, so an archived role
   * stops being assignable without anything being removed. Deleting would take
   * the history with it and break the audit trail's references.
   */
  async archiveRole(enterpriseId: number, roleId: number): Promise<number> {
    const { affected } = await this.mutate(
      `UPDATE roles SET status = $3, updated_at = now()
        WHERE enterprise_id = $1 AND id = $2 AND is_deleted = false AND is_system = false
        RETURNING id`,
      [this.requireEnterprise(enterpriseId), roleId, RoleStatus.Archived],
    );
    return affected;
  }

  /** Replaces one employee's roles with exactly this set, inside a transaction. */
  async replaceEmployeeRoles(input: {
    enterpriseId: number;
    employeeId: number;
    roleIds: readonly number[];
    grantedByEmployeeId: number | null;
  }): Promise<void> {
    await this.query(
      `DELETE FROM employee_roles WHERE enterprise_id = $1 AND employee_id = $2`,
      [this.requireEnterprise(input.enterpriseId), input.employeeId],
    );
    if (input.roleIds.length === 0) return;

    await this.guard(async () => {
      await this.query(
        `INSERT INTO employee_roles (enterprise_id, employee_id, role_id, granted_by_employee_id)
         SELECT $1, $2, unnest($3::bigint[]), $4
         ON CONFLICT DO NOTHING`,
        [input.enterpriseId, input.employeeId, [...input.roleIds], input.grantedByEmployeeId],
      );
    });
  }

  /** Several roles by refId, within one enterprise. Missing ones simply do not appear. */
  async findManyByRefIds(enterpriseId: number, refIds: readonly string[]): Promise<RoleRow[]> {
    if (refIds.length === 0) return [];
    return this.query<RoleRow>(
      `SELECT r.id, r.ref_id AS "refId", r.name, r.scope, r.level,
              r.is_system AS "isSystem",
              COALESCE(
                array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}'
              ) AS "permissionCodes"
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = false
         LEFT JOIN permissions p ON p.id = rp.permission_id AND p.is_deleted = false
                                AND p.status = $4
        WHERE r.enterprise_id = $1 AND r.ref_id = ANY($2::uuid[])
          AND r.is_deleted = false AND r.status = $3
        GROUP BY r.id`,
      [
        this.requireEnterprise(enterpriseId),
        [...refIds],
        RoleStatus.Active,
        PermissionStatus.Active,
      ],
    );
  }

  async findByNameInEnterprise(enterpriseId: number, name: string): Promise<RoleRow | null> {
    const rows = await this.query<RoleRow>(
      `SELECT r.id, r.ref_id AS "refId", r.name, r.scope, r.level,
              r.is_system AS "isSystem",
              COALESCE(
                array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}'
              ) AS "permissionCodes"
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = false
         LEFT JOIN permissions p ON p.id = rp.permission_id AND p.is_deleted = false
                                AND p.status = $3
        WHERE r.enterprise_id = $1 AND r.name = $2 AND r.is_deleted = false
        GROUP BY r.id
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), name, PermissionStatus.Active],
    );
    return rows[0] ?? null;
  }

  /**
   * A role by its public refId, WITHIN one enterprise — so a refId belonging to
   * another business simply does not resolve, and no request body can name a
   * role that is not this business's own.
   */
  async findByRefId(enterpriseId: number, refId: string): Promise<RoleRow | null> {
    const rows = await this.query<RoleRow>(
      `SELECT r.id, r.ref_id AS "refId", r.name, r.scope, r.level,
              r.is_system AS "isSystem",
              COALESCE(
                array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}'
              ) AS "permissionCodes"
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = false
         LEFT JOIN permissions p ON p.id = rp.permission_id AND p.is_deleted = false
                                AND p.status = $4
        WHERE r.enterprise_id = $1 AND r.ref_id = $2 AND r.is_deleted = false
          AND r.status = $3
        GROUP BY r.id
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), refId, RoleStatus.Active, PermissionStatus.Active],
    );
    return rows[0] ?? null;
  }

  async listForEnterprise(enterpriseId: number): Promise<RoleRow[]> {
    return this.query<RoleRow>(
      `SELECT r.id, r.ref_id AS "refId", r.name, r.scope, r.level,
              r.is_system AS "isSystem",
              COALESCE(
                array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}'
              ) AS "permissionCodes"
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = false
         LEFT JOIN permissions p ON p.id = rp.permission_id AND p.is_deleted = false
                                AND p.status = $3
        WHERE r.enterprise_id = $1 AND r.is_deleted = false AND r.status = $2
        GROUP BY r.id
        ORDER BY r.level DESC, r.is_system DESC, r.name`,
      [this.requireEnterprise(enterpriseId), RoleStatus.Active, PermissionStatus.Active],
    );
  }

  /**
   * Grants a role to a employee. enterprise_id is passed explicitly because the
   * composite foreign keys require it — and that is exactly what makes pairing
   * one business's employee with another's role impossible.
   */
  async grantToEmployee(input: {
    enterpriseId: number;
    employeeId: number;
    roleId: number;
    grantedByEmployeeId: number | null;
  }): Promise<void> {
    await this.guard(async () => {
      await this.query(
        `INSERT INTO employee_roles (enterprise_id, employee_id, role_id, granted_by_employee_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [
          this.requireEnterprise(input.enterpriseId),
          input.employeeId,
          input.roleId,
          input.grantedByEmployeeId,
        ],
      );
    });
  }

  /**
   * How much authority one employee has, and what they hold.
   *
   * ONE ROUND TRIP, because every authority decision needs all three parts —
   * the level to compare against, the names for the owner rule, and the
   * permission codes for the subset rule — and fetching them separately would
   * put three queries on the path of every grant.
   *
   * The permission codes here are the GRANTED set, deliberately not passed
   * through the feature gate. A business whose inbox subscription has lapsed
   * should still be able to edit a role that mentions inbox permissions; the
   * gate is applied independently every time anybody actually uses one. See
   * rbac-plan.md §3.2 — the other choice is defensible and would produce
   * baffling behaviour.
   */
  async authorityOfEmployee(
    enterpriseId: number,
    employeeId: number,
  ): Promise<{ level: number | null; roleNames: string[]; permissionCodes: string[] }> {
    const rows = await this.query<{ level: number; name: string; codes: string[] }>(
      `SELECT r.level, r.name, COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS codes
         FROM employee_roles er
         JOIN roles r ON r.id = er.role_id AND r.enterprise_id = er.enterprise_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = false
         /*
          * p.status is filtered, so a DEPRECATED permission does not count as
          * held. It fed the subset rule, so without this a retired code could
          * be copied into a new role — inert while deprecated, and silently
          * live the day anybody reactivated it.
          */
         LEFT JOIN permissions p ON p.id = rp.permission_id AND p.is_deleted = false
                                AND p.status = $4
        WHERE er.enterprise_id = $1
          AND er.employee_id = $2
          AND er.is_deleted = false
          AND r.is_deleted = false
          AND r.status = $3
        GROUP BY r.id, r.level, r.name`,
      [this.requireEnterprise(enterpriseId), employeeId, RoleStatus.Active, PermissionStatus.Active],
    );

    const codes = new Set<string>();
    for (const row of rows) for (const code of row.codes) codes.add(code);

    return {
      level: highestRoleLevel(rows.map((row) => row.level)),
      roleNames: rows.map((row) => row.name),
      permissionCodes: [...codes],
    };
  }

  /**
   * How many ACTIVE people still hold the owner role, not counting one.
   *
   * The exclusion is what makes it useful: the caller is about to suspend or
   * re-role that person, and the question is what would be left afterwards.
   * Counting them and subtracting one in the caller would be the same
   * arithmetic written where a future reader can forget it.
   *
   * Employment status matters as much as the grant. An owner who is already
   * suspended cannot log in, so they are not a way back into a business — and
   * treating them as one would let the real last owner be locked out.
   */
  async countOtherActiveOwners(enterpriseId: number, excludingEmployeeId: number): Promise<number> {
    const rows = await this.query<{ count: number }>(
      `SELECT count(DISTINCT er.employee_id)::int AS count
         FROM employee_roles er
         JOIN roles r ON r.id = er.role_id AND r.enterprise_id = er.enterprise_id
         JOIN enterprise_employees e ON e.id = er.employee_id
                                    AND e.enterprise_id = er.enterprise_id
        WHERE er.enterprise_id = $1
          AND er.employee_id <> $2
          AND er.is_deleted = false
          AND r.is_deleted = false
          AND r.status = $3
          AND r.name = $4
          AND e.is_deleted = false
          AND e.status = $5`,
      [
        this.requireEnterprise(enterpriseId),
        excludingEmployeeId,
        RoleStatus.Active,
        SystemRole.Owner,
        EmployeeStatus.Active,
      ],
    );
    return rows[0]?.count ?? 0;
  }

  /**
   * One employee's level, for the "do you outrank them" check.
   *
   * Separate from `authorityOfEmployee` because the TARGET of an action needs
   * only this — pulling their permission codes as well would be fetching a set
   * nobody compares.
   */
  async highestLevelForEmployee(enterpriseId: number, employeeId: number): Promise<number | null> {
    const rows = await this.query<{ level: number | null }>(
      `SELECT max(r.level)::int AS level
         FROM employee_roles er
         JOIN roles r ON r.id = er.role_id AND r.enterprise_id = er.enterprise_id
        WHERE er.enterprise_id = $1
          AND er.employee_id = $2
          AND er.is_deleted = false
          AND r.is_deleted = false
          AND r.status = $3`,
      [this.requireEnterprise(enterpriseId), employeeId, RoleStatus.Active],
    );
    return rows[0]?.level ?? null;
  }

  /**
   * The role names one employee currently holds.
   *
   * Exists so a grant can be checked against the granter's own authority. Names
   * rather than ids, because the comparison is against SystemRole — the ids are
   * per-enterprise, instantiated from the template at signup.
   */
  async listRoleNamesForEmployee(enterpriseId: number, employeeId: number): Promise<string[]> {
    const rows = await this.query<{ name: string }>(
      `SELECT r.name
         FROM employee_roles er
         JOIN roles r ON r.id = er.role_id AND r.enterprise_id = er.enterprise_id
        WHERE er.enterprise_id = $1
          AND er.employee_id = $2
          AND er.is_deleted = false
          AND r.is_deleted = false
          AND r.status = $3`,
      [this.requireEnterprise(enterpriseId), employeeId, RoleStatus.Active],
    );
    return rows.map((row) => row.name);
  }

  /** Grants the owner role created during signup. */
  async grantOwner(
    enterpriseId: number,
    employeeId: number,
    roleIdsByName: Map<string, number>,
  ): Promise<void> {
    const ownerRoleId = roleIdsByName.get(SystemRole.Owner);
    if (ownerRoleId === undefined) {
      // The template seed is missing: fail loudly rather than create an
      // enterprise whose founder can do nothing.
      throw new Error(
        `system role "${SystemRole.Owner}" template is missing — run the seed before signup`,
      );
    }
    await this.grantToEmployee({
      enterpriseId,
      employeeId,
      roleId: ownerRoleId,
      grantedByEmployeeId: null,
    });
  }
}
