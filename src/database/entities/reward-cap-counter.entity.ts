import { Column, Entity } from 'typeorm';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * reward-programs-design.md §8.5 — the frequency cap. THE UNIQUE INDEX IS THE CAP.
 *
 * Claimed with one atomic statement:
 *
 *   INSERT ... VALUES (..., 1, :cap)
 *   ON CONFLICT (enterprise_id, rule_id, customer_id, period_key)
 *   DO UPDATE SET used = used + 1 WHERE used < cap
 *   RETURNING used;
 *
 * Zero rows means capped. There is no window between the check and the write
 * because there is no separate check. Read-then-count is rejected: it locks
 * only rows that already match and does not stop a concurrent insert — the
 * flaw in the published Sylius patch for CVE-2026-31824.
 *
 * NO `is_deleted` AND NO ref_id. A cap row is a fact about a period;
 * soft-deleting one hands out a free slot. Nothing addresses it from outside —
 * it is read through the award that consumed it. The unique index therefore
 * carries no predicate, the same category as an idempotency key.
 */
@Entity('reward_cap_counters')
export class RewardCapCounter extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  programId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  ruleId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  customerId!: number;

  /** `LIFETIME` · `2026-10-19` · `2026-W42` · `2026-10` · `2026`, in PROGRAM time. */
  @Column({ type: 'text' })
  periodKey!: string;

  @Column({ type: 'int' })
  used!: number;

  /** Snapshotted at first claim, so changing the rule cannot retro-grant a slot. */
  @Column({ type: 'int' })
  cap!: number;
}
