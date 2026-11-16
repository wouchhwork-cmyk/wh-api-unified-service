import { Column, Entity, Index } from 'typeorm';
import type { Platform } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';
import { TIMESTAMP_PRECISION } from '../timestamp-precision';

/**
 * How one platform sees one of this person's accounts.
 *
 * SEPARATE FROM THE CUSTOMER because they are different facts. The customer
 * row is what this business holds about somebody; this is what Instagram or
 * Facebook says about them, and the same person is genuinely not the same on
 * both — a different display name, a different picture, a different follower
 * count. Collapsing them into one slot meant the last platform to answer
 * overwrote the others, and would have overwritten anything a colleague
 * typed the moment such a thing existed.
 */
@Entity('customer_platform_profiles')
@Index('customer_platform_profiles_identifier_uniq', ['enterpriseId', 'customerIdentifierId'], {
  unique: true,
})
export class CustomerPlatformProfile extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  /**
   * The ACCOUNT this is a profile of.
   *
   * Not (customer, platform): a merge can give one customer two Instagram
   * accounts, and keying on the platform would collapse them into one row —
   * the same overwrite this table exists to prevent, one level down.
   */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  customerIdentifierId!: number;

  /** Denormalised from the identifier, so "any profile for this person" is
   * one index probe rather than a join. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  customerId!: number;

  @Column({ type: 'varchar', length: 30 })
  platform!: Platform;

  @Column({ type: 'varchar', length: 255, nullable: true })
  displayName!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  firstName!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastName!: string | null;

  /**
   * A signed CDN link, which expires.
   *
   * `fetchedAt` sits beside it for that reason: an avatar is something this
   * service refreshes, not something it stores once and trusts for ever.
   */
  @Column({ type: 'text', nullable: true })
  avatarUrl!: string | null;

  /** follower_count, is_verified, the follow flags — this platform's view. */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Record<string, unknown>;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  fetchedAt!: Date | null;
}
