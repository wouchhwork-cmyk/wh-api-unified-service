import { Injectable } from '@nestjs/common';
import {
  EmployeeStatus,
  EnterpriseFeatureStatus,
  PermissionStatus,
  RoleStatus,
  StaffStatus,
} from '@/shared/enums';
import { BaseRepository } from './base.repository';

@Injectable()
export class PermissionRepository extends BaseRepository {
  /**
   * The two-gate check from schema.md, resolved as ONE query in ONE place:
   *
   *   Gate 1 — does the enterprise have the feature?  enterprise_features.status = 'active'
   *   Gate 2 — do the employee's roles grant the action? employee_roles -> role_permissions
   *
   * Gate 1 is commercial, gate 2 is structural, and neither implies the other.
   * A permission with feature_id NULL is not feature-gated and skips gate 1.
   *
   * Returns the full permission-code set for the employee, because the guard needs
   * every code once per request rather than one query per check.
   */
  async listEffectivePermissions(employeeId: number, enterpriseId: number): Promise<string[]> {
    const rows = await this.query<{ code: string }>(
      `SELECT DISTINCT p.code
         FROM employee_roles     mr
         /*
          * THE EMPLOYMENT ITSELF MUST STILL BE ACTIVE.
          *
          * Without this join a suspended employee keeps every permission until
          * their access token expires — up to fifteen minutes of full access
          * after being switched off, which makes "suspend" a suggestion rather
          * than a control. Everything else in this system resolves per request
          * precisely so that revocation means now.
          */
         JOIN enterprise_employees emp ON emp.id = mr.employee_id
                                      AND emp.enterprise_id = mr.enterprise_id
                                      AND emp.is_deleted = false
                                      AND emp.status = $6
         JOIN roles            r  ON r.id = mr.role_id
                                 AND r.is_deleted = false
                                 AND r.status = $3
         JOIN role_permissions rp ON rp.role_id = mr.role_id
                                 AND rp.is_deleted = false
         JOIN permissions      p  ON p.id = rp.permission_id
                                 AND p.is_deleted = false
                                 AND p.status = $4
         LEFT JOIN enterprise_features ef ON ef.feature_id = p.feature_id
                                         AND ef.enterprise_id = mr.enterprise_id
                                         AND ef.is_deleted = false
        WHERE mr.employee_id = $1
          AND mr.enterprise_id = $2
          AND mr.is_deleted = false
          AND (p.feature_id IS NULL OR ef.status = $5)`,
      [
        employeeId,
        this.requireEnterprise(enterpriseId),
        RoleStatus.Active,
        PermissionStatus.Active,
        EnterpriseFeatureStatus.Active,
        EmployeeStatus.Active,
      ],
    );
    return rows.map((row) => row.code);
  }

  /**
   * Staff with platform-wide reach bypass gate 2 but NOT gate 1. So their
   * effective set is every permission whose feature the enterprise actually has
   * — reach and entitlement are different questions.
   *
   * GATED ON THE STAFF ROW ITSELF, not just on the token. The set returned here
   * is every staff-assignable code, so "is this person still platform staff"
   * cannot be a question the caller is trusted to have already asked: the query
   * re-asks it, on the row, every time. Before this it did not, so a staff
   * member whose row was suspended or downgraded — or whose token merely
   * outlived either — still resolved to the full set, and the failure mode of the
   * highest-privilege path in the service was fail-OPEN.
   *
   * TWO KINDS OF STAFF, since `staff_roles` exists (backlog B3):
   *
   *   has_all_enterprise_access = true   every staff-scoped permission. The
   *                                      platform admin. Unchanged, so no
   *                                      existing console access moves.
   *   has_all_enterprise_access = false  only what their staff ROLES grant.
   *                                      Previously this person could log in
   *                                      and reach nothing at all, because
   *                                      there was no way to grant them
   *                                      anything — `support` and `ops` were
   *                                      structurally ungrantable.
   *
   * The flag stays the superuser switch rather than becoming another role,
   * because it is what `PlatformAdminGuard` asks and what decides whether
   * somebody may reach into a tenant at all. Folding it into the role system
   * would mean a single bad grant could hand out platform-wide reach.
   */
  async listStaffPermissions(staffId: number, enterpriseId: number | null): Promise<string[]> {
    const staff = await this.staffStanding(staffId);
    if (!staff.active) return [];
    if (!staff.hasAllEnterpriseAccess) {
      return this.listStaffRolePermissions(staffId, enterpriseId);
    }

    if (enterpriseId === null) {
      // No enterprise selected yet: only permissions that are not feature-gated
      // can possibly apply.
      const rows = await this.query<{ code: string }>(
        `SELECT code FROM permissions
          WHERE is_deleted = false AND status = $1 AND feature_id IS NULL
            AND scope IN ('staff','both')`,
        [PermissionStatus.Active],
      );
      return rows.map((row) => row.code);
    }

    const rows = await this.query<{ code: string }>(
      `SELECT p.code
         FROM permissions p
         LEFT JOIN enterprise_features ef ON ef.feature_id = p.feature_id
                                         AND ef.enterprise_id = $1
                                         AND ef.is_deleted = false
        WHERE p.is_deleted = false
          AND p.status = $2
          AND p.scope IN ('staff','both')
          AND (p.feature_id IS NULL OR ef.status = $3)`,
      [
        this.requireEnterprise(enterpriseId),
        PermissionStatus.Active,
        EnterpriseFeatureStatus.Active,
      ],
    );
    return rows.map((row) => row.code);
  }

  /** Still one of ours, still active, still full-reach — asked of the row, now. */
  private async staffStanding(
    staffId: number,
  ): Promise<{ active: boolean; hasAllEnterpriseAccess: boolean }> {
    const rows = await this.query<{ hasAllEnterpriseAccess: boolean }>(
      `SELECT has_all_enterprise_access AS "hasAllEnterpriseAccess"
         FROM staff_members
        WHERE id = $1 AND status = $2 AND is_deleted = false
        LIMIT 1`,
      [staffId, StaffStatus.Active],
    );
    const row = rows[0];
    return {
      active: row !== undefined,
      hasAllEnterpriseAccess: row?.hasAllEnterpriseAccess ?? false,
    };
  }

  /**
   * A scoped staff member's permissions: only what their staff roles grant.
   *
   * Still subject to gate 1 — a permission whose feature the business does not
   * have is not returned, exactly as for an employee. Reach and entitlement are
   * different questions, and being one of ours answers only the first.
   */
  private async listStaffRolePermissions(
    staffId: number,
    enterpriseId: number | null,
  ): Promise<string[]> {
    const featurePredicate =
      enterpriseId === null
        ? // No business selected, so nothing feature-gated can apply yet.
          'AND p.feature_id IS NULL'
        : 'AND (p.feature_id IS NULL OR ef.status = $4)';

    const rows = await this.query<{ code: string }>(
      `SELECT DISTINCT p.code
         FROM staff_roles sr
         JOIN roles r ON r.id = sr.role_id AND r.scope = sr.role_scope
         JOIN role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = false
         JOIN permissions p ON p.id = rp.permission_id AND p.is_deleted = false
         LEFT JOIN enterprise_features ef ON ef.feature_id = p.feature_id
                                         AND ef.enterprise_id = $3
                                         AND ef.is_deleted = false
        WHERE sr.staff_id = $1
          AND sr.is_deleted = false
          AND r.is_deleted = false
          AND r.status = $2
          AND p.is_deleted = false
          AND p.status = $5
          ${featurePredicate}`,
      enterpriseId === null
        ? [staffId, RoleStatus.Active, null, null, PermissionStatus.Active]
        : [
            staffId,
            RoleStatus.Active,
            enterpriseId,
            EnterpriseFeatureStatus.Active,
            PermissionStatus.Active,
          ],
    );
    return rows.map((row) => row.code);
  }
}
