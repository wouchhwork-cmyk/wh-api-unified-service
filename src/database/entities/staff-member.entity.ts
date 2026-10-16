import { Column, Entity } from 'typeorm';
import { StaffStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * schema.md §4 — Wouchh's own people. Separate from `enterprise_employees`
 * because platform-wide access cannot be expressed as a list of employments:
 * new businesses sign up continuously and would each need a backfill.
 *
 * Staff roles and permissions come from the same `roles` / `permissions` tables
 * using `roles.scope = 'staff'`, so there is one permission engine, not two.
 */
@Entity('staff_members')
export class StaffMember extends PublicEntity {
  /** One staff record per human (unique among live rows). */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  identityId!: number;

  /**
   * true = every business, present and future — the super admin, who needs no
   * `enterprise_employees` rows at all. false = reach comes from one
   * `enterprise_employees` row per assigned business with `employeeKind = 'staff'`.
   */
  @Column({ type: 'boolean', default: false })
  hasAllEnterpriseAccess!: boolean;

  @Column({ type: 'varchar', length: 30, default: StaffStatus.Active })
  status!: StaffStatus;
}
