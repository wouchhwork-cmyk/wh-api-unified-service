import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';

export interface AuditLogInsert {
  readonly enterpriseId: number | null;
  readonly actorIdentityId: number | null;
  readonly actorEmployeeId: number | null;
  readonly actorStaffId: number | null;
  readonly actorKind: string;
  readonly isImpersonated: boolean;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: number | null;
  readonly changes: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly status: string;
}

/**
 * INSERT and SELECT only, enforced by the database as well as by policy: a
 * BEFORE UPDATE OR DELETE trigger on `audit_logs` raises, so there is no
 * `update` method here to be tempted by — and no way to add one that would work.
 *
 * The trigger rather than the REVOKE is what carries this. The REVOKE is
 * conditional on the application role differing from the migration role, which
 * it does not on a developer machine or anywhere DB_APP_ROLE is unset, so for a
 * long time this comment described a guarantee that was not in force.
 */
@Injectable()
export class AuditLogRepository extends BaseRepository {
  async insert(entry: AuditLogInsert): Promise<void> {
    await this.query(
      `INSERT INTO audit_logs (
         enterprise_id, actor_identity_id, actor_employee_id, actor_staff_id,
         actor_kind, is_impersonated, action, entity_type, entity_id,
         changes, metadata, ip_address, user_agent, status
       ) VALUES ($1, $2, $3, $4, $5::varchar, $6, $7::varchar, $8::varchar, $9,
                 $10::jsonb, $11::jsonb, $12::inet, $13, $14::varchar)`,
      [
        entry.enterpriseId,
        entry.actorIdentityId,
        entry.actorEmployeeId,
        entry.actorStaffId,
        entry.actorKind,
        entry.isImpersonated,
        entry.action,
        entry.entityType,
        entry.entityId,
        JSON.stringify(entry.changes),
        JSON.stringify(entry.metadata),
        entry.ipAddress,
        entry.userAgent,
        entry.status,
      ],
    );
  }
}
