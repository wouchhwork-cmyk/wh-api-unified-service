import { Column, Entity } from 'typeorm';
import { RewardProgramStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';
import { TIMESTAMP_PRECISION } from '../timestamp-precision';

/**
 * reward-programs-design.md §8.1 — one campaign.
 *
 * `status` is the SWITCH, not the schedule. A program scheduled for next month
 * sits `active` with a future `starts_at`; there is no `scheduled` status
 * because the date already says it, and no `ended` because `ends_at` does.
 * Two columns answering one question is the duplication schema.md rejects when
 * it forbids `deleted` inside any status enum.
 */
@Entity('reward_programs')
export class RewardProgram extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: RewardProgramStatus.Draft })
  status!: RewardProgramStatus;

  /**
   * Resolves `period_key` AND every time window. A Mumbai café's "once a day"
   * must not reset at 05:30 local, and a recurring 6pm window must stay 6pm
   * across a DST boundary.
   */
  @Column({ type: 'varchar', length: 64 })
  timezone!: string;

  /** Default for currency benefits; a benefit may state another. */
  @Column({ type: 'char', length: 3, nullable: true })
  defaultCurrencyCode!: string | null;

  /** NULL = uncapped. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  budgetMinor!: number | null;

  @Column({ type: 'char', length: 3, nullable: true })
  budgetCurrencyCode!: string | null;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  spentMinor!: number;

  /** NULL = already running. May be in the FUTURE — that is a scheduled program. */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  startsAt!: Date | null;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  endsAt!: Date | null;

  /**
   * NULL = value stays in Wouchh. `'noop'` records intent and moves nothing.
   *
   * The destination must belong to THIS enterprise. Forwarding to a third
   * party is third-party settlement, which is the line out of the closed-loop
   * carve-out (§15).
   */
  @Column({ type: 'varchar', length: 40, nullable: true })
  forwardProviderCode!: string | null;

  /** Endpoint and mapping. A SECRET REFERENCE, never a secret. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  forwardConfig!: Record<string, unknown>;
}
