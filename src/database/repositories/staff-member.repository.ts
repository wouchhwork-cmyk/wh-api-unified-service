import { Injectable } from '@nestjs/common';
import { StaffStatus } from '@/shared/enums';
import { BaseRepository } from './base.repository';

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
}
