import { Column, Entity } from 'typeorm';
import { EnterpriseFeatureStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * schema.md §10 — which features a business has, and where each one is in its
 * lifecycle. This is gate 1 of access control: commercial entitlement, separate
 * from what a person may do with it (§5–8).
 *
 * A feature never requested has no row, "which reads the same as not enabled".
 */
@Entity('enterprise_features')
export class EnterpriseFeature extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  featureId!: number;

  /** Per-business limits and settings for this feature. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  config!: Record<string, unknown>;

  /**
   * The single source of truth for enablement: "the check is `status = 'active'`,
   * and nothing else". There is deliberately no `is_enabled` boolean — it would
   * be a second answer to the same question and the two could disagree.
   */
  @Column({ type: 'varchar', length: 30, default: EnterpriseFeatureStatus.AccessRequested })
  status!: EnterpriseFeatureStatus;

  /** Who asked. NULL = we provisioned it without a request. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  requestedByMemberId!: number | null;

  /*
   * The timestamps below are AUDIT TRAIL, NOT STATE — never read them to decide
   * whether a feature is on; only `status` answers that. Only the latest
   * transition of each kind is kept; full history lives in `audit_logs` with
   * entity_type = 'enterprise_feature'.
   */

  @Column({ type: 'timestamptz', nullable: true })
  requestedAt!: Date | null;

  /** Which Wouchh staff member approved or declined. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  decidedByStaffId!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  /** Shown to the business. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  declineReason!: string | null;

  /** When it last became usable. */
  @Column({ type: 'timestamptz', nullable: true })
  enabledAt!: Date | null;

  /** When it last stopped being usable. */
  @Column({ type: 'timestamptz', nullable: true })
  disabledAt!: Date | null;

  /**
   * Trial / contract end; NULL = no expiry. Drives the sweep that moves
   * `active` → `expired`. Warning window and cadence are configuration.
   */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;
}
