import { Column, Entity } from 'typeorm';
import { RewardEntitlementStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';
import { TIMESTAMP_PRECISION } from '../timestamp-precision';

/**
 * reward-programs-design.md §8.10 — an issued right, NOT a balance.
 *
 * A free coffee is not a number that goes up. It is a lifecycle:
 * issued → reserved → redeemed, or expired / revoked.
 *
 * V1 WRITES THESE ROWS AND NOTHING REDEEMS THEM. That is the deliberate seam:
 * the award path, the cap, the ledger and the audit trail are all exercised,
 * and the deferred work is the catalogue behind `item_ref` plus the redemption
 * endpoint. Neither touches anything above.
 */
@Entity('reward_entitlements')
export class RewardEntitlement extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  customerId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  awardId!: number;

  /** Opaque in V1. The catalogue behind it is a later table. */
  @Column({ type: 'varchar', length: 64 })
  itemRef!: string;

  @Column({ type: 'varchar', length: 16, default: RewardEntitlementStatus.Issued })
  status!: RewardEntitlementStatus;

  /**
   * What a customer reads out at a till — short and typeable, where `ref_id` is
   * long and opaque. UNGUESSABLE and never derived from the customer or the
   * item: a 2014 case saw a user replace his referral code with a memorable
   * one, seed it publicly, and collect over $50,000.
   */
  @Column({ type: 'varchar', length: 32 })
  redemptionCode!: string;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, default: () => 'now()' })
  issuedAt!: Date;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  expiresAt!: Date | null;

  /** Reserve-then-commit at the till; a reaper releases abandonments. */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  reservedUntil!: Date | null;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  redeemedAt!: Date | null;
}
