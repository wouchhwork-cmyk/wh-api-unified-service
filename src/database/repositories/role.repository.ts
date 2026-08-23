import { Injectable } from '@nestjs/common';
import { RoleScope, RoleStatus, SystemRole } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface RoleRow {
  readonly id: number;
  /** The only identifier that crosses the API boundary. */
  readonly refId: string;
  readonly name: string;
  readonly scope: RoleScope;
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
      `INSERT INTO roles (enterprise_id, scope, name, description, is_system, status)
       SELECT $1, t.scope, t.name, t.description, true, $2
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

  async findByNameInEnterprise(enterpriseId: number, name: string): Promise<RoleRow | null> {
    const rows = await this.query<RoleRow>(
      `SELECT id, name, scope FROM roles
        WHERE enterprise_id = $1 AND name = $2 AND is_deleted = false LIMIT 1`,
      [this.requireEnterprise(enterpriseId), name],
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
      `SELECT id, ref_id AS "refId", name, scope FROM roles
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false AND status = $3
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), refId, RoleStatus.Active],
    );
    return rows[0] ?? null;
  }

  async listForEnterprise(enterpriseId: number): Promise<RoleRow[]> {
    return this.query<RoleRow>(
      `SELECT id, ref_id AS "refId", name, scope FROM roles
        WHERE enterprise_id = $1 AND is_deleted = false AND status = $2
        ORDER BY is_system DESC, name`,
      [this.requireEnterprise(enterpriseId), RoleStatus.Active],
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
