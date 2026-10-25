import { Column, Entity } from 'typeorm';
import { RewardBenefitKind, RewardBenefitStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';
import { TIMESTAMP_PRECISION } from '../timestamp-precision';

/**
 * reward-programs-design.md §8.4 — what an award actually did, and how to undo it.
 *
 * RECORD THE OUTCOME, REVERSE THE RECORD. `compensation` holds what the handler
 * PRODUCED — the ledger entry it wrote, the entitlement it issued. A
 * compensator that re-derives what to undo from the rule produces a wrong
 * reversal the moment the rule is edited between apply and compensate, and
 * `rule_version` does not cover a factor that read live engagement data.
 *
 * Vendure's `onDeactivate` receives the same inputs as `onActivate` and must
 * re-derive. Medusa captures the undo payload at apply time. This follows
 * Medusa.
 *
 * NO ref_id: reached through its award, never addressed alone.
 */
@Entity('reward_award_benefits')
export class RewardAwardBenefit extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  awardId!: number;

  @Column({ type: 'smallint' })
  benefitIndex!: number;

  /** Copied, so the award stays explainable after the rule changes. */
  @Column({ type: 'varchar', length: 32 })
  benefitKind!: RewardBenefitKind;

  /** The RESOLVED benefit, after the factor. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, default: RewardBenefitStatus.Applied })
  status!: RewardBenefitStatus;

  /** What the handler produced. The compensator reads THIS. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  compensation!: Record<string, unknown>;

  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  compensatesBenefitId!: number | null;

  @Column({ type: 'text' })
  idempotencyKey!: string;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  appliedAtUtc!: Date | null;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  compensatedAtUtc!: Date | null;
}
