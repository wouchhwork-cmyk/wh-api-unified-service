import { Column, Entity } from 'typeorm';
import { RewardAwardStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';
import { TIMESTAMP_PRECISION } from '../timestamp-precision';

/**
 * reward-programs-design.md §8.6 — one rule firing for one customer on one event.
 *
 * NO TOTALS HERE. `points` and `amount_minor` used to sit on this row as a sum
 * of the award's benefits, and that violated the rule stated two sections
 * earlier: an award holding a ₹50 benefit and a $2 benefit cannot be one
 * `amount_minor` with one `currency_code`. Value is never netted across
 * wallets, so the benefits are read.
 *
 * A SKIPPED AWARD IS STILL A ROW. "Why didn't I get my points?" is a question
 * the enterprise will be asked, and `status` plus `period_key` answers it in
 * one lookup.
 */
@Entity('reward_awards')
export class RewardAward extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  programId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  ruleId!: number;

  /** WHICH VERSION decided this. The rule may have been edited since. */
  @Column({ type: 'int' })
  ruleVersion!: number;

  /**
   * And which version of the PROGRAM the rule belonged to at the time.
   *
   * The rule version says what was awarded and why; this says what the rule
   * was part of — the name, the schedule, the whole configuration as it stood,
   * recoverable from `entity_versions`. NULL means the award predates this
   * being recorded, which is not the same as version 1.
   */
  @Column({ type: 'int', nullable: true })
  programVersion!: number | null;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  customerId!: number;

  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  channelId!: number | null;

  /** `message` or `post` — the row that caused this. */
  @Column({ type: 'varchar', length: 20 })
  sourceRefKind!: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  sourceRefId!: number;

  @Column({ type: 'varchar', length: 24, default: RewardAwardStatus.Held })
  status!: RewardAwardStatus;

  /** `0..10000`, post-clamp. NULL when every benefit was `fixed`. */
  @Column({ type: 'int', nullable: true })
  factorBasisPoints!: number | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  factorProviderCode!: string | null;

  /**
   * WHAT THE FACTOR READ, not just what it returned.
   *
   * Storing only the output makes "why 0.7?" unanswerable the moment the
   * engagement data moves on — which is the same standing rule as capturing
   * every field Meta gives us, applied to a derived value.
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  factorInputs!: Record<string, unknown>;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  factorComputedAt!: Date | null;

  /** Which cap slot this consumed. THE "why not?" ANSWER. */
  @Column({ type: 'text', nullable: true })
  periodKey!: string | null;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  heldUntil!: Date | null;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  grantedAt!: Date | null;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  reversedAt!: Date | null;

  /** Why skipped, or why reversed. Names the failing condition for gate 4. */
  @Column({ type: 'varchar', length: 60, nullable: true })
  reasonCode!: string | null;

  /** When the customer ACTED. The window and the cap are judged against this. */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION })
  occurredAtUtc!: Date;
}
