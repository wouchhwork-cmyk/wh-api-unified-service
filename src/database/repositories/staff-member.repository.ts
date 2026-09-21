import { Injectable } from '@nestjs/common';
import { RoleScope, RoleStatus, StaffStatus } from '@/shared/enums';
import { BaseRepository } from './base.repository';

/** One of our own people, as the platform console lists them. */
export interface StaffListRow {
  readonly id: number;
  readonly refId: string;
  readonly status: StaffStatus;
  readonly hasAllEnterpriseAccess: boolean;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly lastLoginAt: Date | null;
  readonly roles: string[];
}

export interface StaffSummary {
  readonly staffId: number;
  readonly hasAllEnterpriseAccess: boolean;
}

export interface StaffRecord extends StaffSummary {
  /**
   * Typed as the enum, not `string`. The column is a varchar, but every caller
   * compares it against StaffStatus — and a string-to-enum comparison is
   * silently always-false if either side is ever renamed.
   */
  readonly status: StaffStatus;
}

@Injectable()
export class StaffMemberRepository extends BaseRepository {
  /**
   * Wouchh's own people. `has_all_enterprise_access` grants REACH into any
   * enterprise but never bypasses the feature gate — a feature the enterprise
   * does not have does not exist for anyone (schema.md §8).
   */
  async findActiveByIdentity(identityId: number): Promise<StaffSummary | null> {
    const rows = await this.query<StaffSummary>(
      `SELECT id AS "staffId", has_all_enterprise_access AS "hasAllEnterpriseAccess"
         FROM staff_members
        WHERE identity_id = $1 AND status = $2 AND is_deleted = false
        LIMIT 1`,
      [identityId, StaffStatus.Active],
    );
    return rows[0] ?? null;
  }

  /**
   * Any staff row for this identity, active or not.
   *
   * Separate from findActiveByIdentity because provisioning has to be able to
   * SEE a suspended row in order to reactivate it. The auth path must never use
   * this one: a suspended staff employee logging in would be a hole.
   */
  async findAnyByIdentity(identityId: number): Promise<StaffRecord | null> {
    const rows = await this.query<StaffRecord>(
      `SELECT id     AS "staffId",
              has_all_enterprise_access AS "hasAllEnterpriseAccess",
              status AS "status"
         FROM staff_members
        WHERE identity_id = $1 AND is_deleted = false
        LIMIT 1`,
      [identityId],
    );
    return rows[0] ?? null;
  }

  async create(input: {
    identityId: number;
    hasAllEnterpriseAccess: boolean;
  }): Promise<StaffSummary> {
    const rows = await this.query<StaffSummary>(
      `INSERT INTO staff_members (identity_id, has_all_enterprise_access, status)
            VALUES ($1, $2, $3)
         RETURNING id AS "staffId", has_all_enterprise_access AS "hasAllEnterpriseAccess"`,
      [input.identityId, input.hasAllEnterpriseAccess, StaffStatus.Active],
    );
    const created = rows[0];
    if (!created) throw new Error('staff_members insert returned no row');
    return created;
  }

  /** Used only by provisioning, to bring a row back to the configured state. */
  async activateWithFullAccess(staffId: number): Promise<void> {
    await this.mutate(
      `UPDATE staff_members
          SET status = $2, has_all_enterprise_access = true, updated_at = now()
        WHERE id = $1 AND is_deleted = false`,
      [staffId, StaffStatus.Active],
    );
  }

  /**
   * Wouchh's own people, with the staff roles each one holds.
   *
   * NOT tenant-scoped, and cannot be: staff exist above every tenant, which is
   * the whole reason they are a separate table from `enterprise_employees`.
   * The only caller is the platform console, gated on platform staff.
   *
   * Contact details are masked by the service, as everywhere else — this is an
   * internal list, and an internal list is still the most screenshotted kind.
   */
  async listWithRoles(): Promise<StaffListRow[]> {
    return this.query<StaffListRow>(
      `SELECT s.id,
              s.ref_id AS "refId",
              s.status,
              s.has_all_enterprise_access AS "hasAllEnterpriseAccess",
              i.first_name AS "firstName",
              i.last_name  AS "lastName",
              i.email      AS "email",
              i.last_login_at AS "lastLoginAt",
              COALESCE(
                array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}'
              ) AS "roles"
         FROM staff_members s
         JOIN identities i ON i.id = s.identity_id AND i.is_deleted = false
         LEFT JOIN staff_roles sr ON sr.staff_id = s.id AND sr.is_deleted = false
         LEFT JOIN roles r ON r.id = sr.role_id AND r.scope = sr.role_scope
                          AND r.is_deleted = false
        WHERE s.is_deleted = false
        GROUP BY s.id, i.id
        ORDER BY s.created_at ASC`,
    );
  }

  async findByRefId(refId: string): Promise<{ id: number; hasAllEnterpriseAccess: boolean } | null> {
    const rows = await this.query<{ id: number; hasAllEnterpriseAccess: boolean }>(
      `SELECT id, has_all_enterprise_access AS "hasAllEnterpriseAccess"
         FROM staff_members WHERE ref_id = $1 AND is_deleted = false LIMIT 1`,
      [refId],
    );
    return rows[0] ?? null;
  }

  /**
   * The staff roles a platform admin can hand out.
   *
   * The NULL-enterprise, staff-scoped templates — `support` and `ops` today.
   * They are granted directly rather than copied per tenant, because staff
   * authority is not scoped to a business and there is no tenant to copy into.
   */
  async listStaffRoleOptions(): Promise<{ id: number; refId: string; name: string }[]> {
    return this.query(
      `SELECT id, ref_id AS "refId", name
         FROM roles
        WHERE enterprise_id IS NULL AND scope = $1 AND is_deleted = false AND status = $2
        ORDER BY name`,
      [RoleScope.Staff, RoleStatus.Active],
    );
  }

  /**
   * Replaces exactly which staff roles somebody holds.
   *
   * The composite foreign key on `(role_id, role_scope)` means an
   * enterprise-scoped role cannot be inserted here at all, so this method does
   * not need to check the scope — the database refuses it. That is the point of
   * the constraint rather than a happy accident.
   */
  async replaceStaffRoles(input: {
    staffId: number;
    roleIds: readonly number[];
    grantedByStaffId: number | null;
  }): Promise<void> {
    await this.query(`DELETE FROM staff_roles WHERE staff_id = $1`, [input.staffId]);
    if (input.roleIds.length === 0) return;

    await this.guard(async () => {
      await this.query(
        `INSERT INTO staff_roles (staff_id, role_id, role_scope, granted_by_staff_id)
         SELECT $1, unnest($2::bigint[]), $3, $4
         ON CONFLICT DO NOTHING`,
        [input.staffId, [...input.roleIds], RoleScope.Staff, input.grantedByStaffId],
      );
    });
  }
}
