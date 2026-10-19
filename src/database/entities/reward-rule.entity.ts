import { Column, Entity } from 'typeorm';
import { RewardCapScope, RewardReversalPolicy, RewardTriggerKind } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * reward-programs-design.md §8.2 — one trigger, N benefits, N conditions.
 *
 * NO REWARD COLUMNS HERE. What a rule awards lives in `reward_rule_benefits`,
 * because a rule owns several. Keeping `points`/`amount_minor` here would mean
 * one benefit per rule — "20 points AND a free coffee" would need two rules,
 * two cap counters and two budget claims, one of which could be skipped while
 * the other granted.
 *
 * RULES ARE VERSIONED AND NEVER EDITED IN PLACE. An award stores the version
 * that decided it, so editing a rule cannot silently rewrite the explanation of
 * every award already granted under it.
 */
@Entity('reward_rules')
export class RewardRule extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  programId!: number;

  @Column({ type: 'int' })
  version!: number;

  /** NULL for v1 of a rule. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  supersedesRuleId!: number | null;

  @Column({ type: 'varchar', length: 40 })
  triggerKind!: RewardTriggerKind;

  /** Channel restriction, postback payload, referral `ref` — matched, never summed. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  triggerConfig!: Record<string, unknown>;

  /** Which factor decides an `up_to` benefit. V1 ships `constant_one`. */
  @Column({ type: 'varchar', length: 40 })
  factorProviderCode!: string;

  @Column({ type: 'varchar', length: 10 })
  capScope!: RewardCapScope;

  @Column({ type: 'int', default: 1 })
  capCount!: number;

  /**
   * Doubles as the reversal window AND the settling time for the factor —
   * engagement counts are near zero when a comment arrives.
   */
  @Column({ type: 'int', default: 0 })
  holdHours!: number;

  @Column({ type: 'varchar', length: 20, default: RewardReversalPolicy.None })
  reversalPolicy!: RewardReversalPolicy;

  /** Deterministic ordering when several rules match one event. */
  @Column({ type: 'int', default: 0 })
  priority!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;
}
