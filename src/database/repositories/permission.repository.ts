import { Injectable } from '@nestjs/common';
import {
  EmployeeStatus,
  EnterpriseFeatureStatus,
  PermissionStatus,
  RoleStatus,
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
   */
  async listStaffPermissions(enterpriseId: number | null): Promise<string[]> {
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
}
