import { Column, Entity } from 'typeorm';
import type { Platform } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * schema.md §18 — where a customer actually engages, and how much. One row per
 * customer per CHANNEL, so a customer who DMs on Instagram and comments on a
 * Facebook Page has two rows. This answers "which platforms is this customer
 * engaging on", which `customers.first_source` cannot.
 *
 * NO `status` column: this table has no lifecycle of its own — "dormant" is
 * `last_engaged_at` being old, and deriving it into a column would be a second
 * answer to a question the timestamp already answers. `is_deleted` exists only
 * for repository-pattern uniformity.
 *
 * Maintained by the projector in the same transaction as the message write, not
 * derived on read — so it can drift, and it joins the reconciliation set.
 */
@Entity('customer_engagements')
export class CustomerEngagement extends BaseEntity {
  /** Tenant key — leads every index here. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  customerId!: number;

  /** The specific surface they engage on — channel grain, not platform grain. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  channelId!: number;

  /**
   * Denormalized from the channel "so filtering by platform needs no join" —
   * the common segment query filters on platform without caring which specific
   * channel. A customer's platform answer is the distinct set across their rows.
   */
  @Column({ type: 'varchar', length: 30 })
  platform!: Platform;

  /** First interaction on this channel. */
  @Column({ type: 'timestamptz' })
  firstEngagedAt!: Date;

  /** Most recent — the sort key for "recently active where". */
  @Column({ type: 'timestamptz' })
  lastEngagedAt!: Date;

  /** Threads on this channel. */
  @Column({ type: 'int', default: 0 })
  conversationCount!: number;

  /** What they sent us here. */
  @Column({ type: 'int', default: 0 })
  inboundMessageCount!: number;

  /** What we sent them here. */
  @Column({ type: 'int', default: 0 })
  outboundMessageCount!: number;

  /** Most recent thread on this channel. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  lastConversationId!: number | null;
}
