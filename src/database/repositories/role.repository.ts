import { Injectable } from '@nestjs/common';
import { RoleScope, RoleStatus, SystemRole } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface RoleRow {
  readonly id: number;
  readonly name: string;
  readonly scope: RoleScope;
}

@Injectable()
export class RoleRepository extends BaseRepository {
  /**
   * Instantiates the enterprise's own system roles by COPYING the NULL-enterprise
   * templates, together with their permission grants.
   *
   * This copy is not incidental: member_roles routes both foreign keys through
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

  async listForEnterprise(enterpriseId: number): Promise<RoleRow[]> {
    return this.query<RoleRow>(
      `SELECT id, name, scope FROM roles
        WHERE enterprise_id = $1 AND is_deleted = false AND status = $2
        ORDER BY is_system DESC, name`,
      [this.requireEnterprise(enterpriseId), RoleStatus.Active],
    );
  }

  /**
   * Grants a role to a member. enterprise_id is passed explicitly because the
   * composite foreign keys require it — and that is exactly what makes pairing
   * one business's member with another's role impossible.
   */
  async grantToMember(input: {
    enterpriseId: number;
    memberId: number;
    roleId: number;
    grantedByMemberId: number | null;
  }): Promise<void> {
    await this.guard(async () => {
      await this.query(
        `INSERT INTO member_roles (enterprise_id, member_id, role_id, granted_by_member_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [
          this.requireEnterprise(input.enterpriseId),
          input.memberId,
          input.roleId,
          input.grantedByMemberId,
        ],
      );
    });
  }

  /** Grants the owner role created during signup. */
  async grantOwner(
    enterpriseId: number,
    memberId: number,
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
    await this.grantToMember({
      enterpriseId,
      memberId,
      roleId: ownerRoleId,
      grantedByMemberId: null,
    });
  }
}
