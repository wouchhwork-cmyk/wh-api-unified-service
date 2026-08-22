import { Injectable } from '@nestjs/common';
import { StaffStatus } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface StaffSummary {
  readonly staffId: number;
  readonly hasAllEnterpriseAccess: boolean;
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
}
