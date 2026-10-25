import { Column, Entity } from 'typeorm';
import { RewardAwardMode, RewardBenefitKind } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * reward-programs-design.md §8.3 — what a rule awards. Ordered, applied
 * all-or-nothing.
 *
 * NO ref_id: a rule is versioned, so editing one replaces its benefits as a
 * SET. Nothing ever addresses a single benefit row, which is the test
 * schema.md states for carrying a public handle.
 *
 * `config` is JSONB rather than typed columns, and that is measured rather than
 * preferred: typed columns make every new benefit kind a migration, which is
 * what Flagsmith is spending a four-figure diff to escape. The arguments for
 * typing it do not apply — reporting reads the ledger, typed either way, and a
 * STORED generated column takes a composite FK the day an item catalogue
 * exists.
 *
 * WHAT THAT COSTS, and how it is paid: Vendure stores the same shape and
 * silently drops a renamed arg while TypeScript asserts it is present. Three
 * layers answer it — Zod on write, Zod on read, and a CI drift test. A
 * constraint is a gate, never an audit.
 */
@Entity('reward_rule_benefits')
export class RewardRuleBenefit extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  ruleId!: number;

  /** Benefits belong to a rule VERSION, not to a rule. */
  @Column({ type: 'int' })
  ruleVersion!: number;

  /** Deterministic order, so ledger entries land in a reproducible sequence. */
  @Column({ type: 'smallint' })
  benefitIndex!: number;

  @Column({ type: 'varchar', length: 32 })
  benefitKind!: RewardBenefitKind;

  /** A SIBLING COLUMN, never a key inside the JSON. Needed the first backfill. */
  @Column({ type: 'smallint', default: 1 })
  benefitSchemaVersion!: number;

  /**
   * Per BENEFIT, not per rule, because scalability is a property of the kind.
   * `grant_points` is continuous — 0.6 × 20 = 12 means something. A free coffee
   * is discrete. With this on the rule, a factor of 0.6 on "20 points and a
   * coffee" produced six tenths of a coffee.
   */
  @Column({ type: 'varchar', length: 10, default: RewardAwardMode.Fixed })
  awardMode!: RewardAwardMode;

  /** `up_to` only: the ceiling the factor scales. */
  @Column({ type: 'int', nullable: true })
  awardCap!: number | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  config!: Record<string, unknown>;
}
