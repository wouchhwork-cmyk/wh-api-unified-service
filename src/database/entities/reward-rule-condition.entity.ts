import { Column, Entity } from 'typeorm';
import { RewardConditionKind } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * reward-programs-design.md §8.9 — extra predicates on a rule.
 *
 * A trigger says WHAT HAPPENED. A condition says WHETHER IT QUALIFIES. Flat AND
 * list, no boolean tree: Vendure — the closest match to this shape and the most
 * mature — chose this deliberately, and Saleor chose the tree and had to build
 * a batched materialisation pipeline with a dirty flag to keep checkout fast.
 *
 * EMPTY LIST MEANS ALWAYS. The absence of conditions must not mean "never" —
 * that would silently disable every rule nobody configured, and storing rows
 * with empty condition groups and no stated meaning was one of the defects in
 * the production coupon engine this design was checked against.
 *
 * The weekly schedule is a condition rather than its own table because "is this
 * inside the window?" is a predicate on the event, exactly like "does this
 * comment contain a keyword". As a table it also could not express a per-rule
 * happy hour — that needed a whole second program.
 */
@Entity('reward_rule_conditions')
export class RewardRuleCondition extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  ruleId!: number;

  @Column({ type: 'int' })
  ruleVersion!: number;

  /** Evaluation order. Cheap predicates first. */
  @Column({ type: 'smallint' })
  conditionIndex!: number;

  @Column({ type: 'varchar', length: 32 })
  conditionKind!: RewardConditionKind;

  @Column({ type: 'smallint', default: 1 })
  conditionSchemaVersion!: number;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  config!: Record<string, unknown>;
}
