import { Column, Entity } from 'typeorm';
import { ActorKind, RewardEntryKind } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';
import { TIMESTAMP_PRECISION } from '../timestamp-precision';

/**
 * reward-programs-design.md §8.8 — THE RECORD. Append-only.
 *
 * No `is_deleted`: an append-only ledger has no delete, soft or otherwise, and
 * offering the column would invite someone to use it. Corrections are reversing
 * entries. A BEFORE UPDATE OR DELETE trigger enforces it in the database,
 * because application discipline alone is not enforcement.
 *
 * IT CARRIES ref_id, despite schema.md exempting "ledger tables". That
 * exemption is about TRANSPORT ledgers — nobody reverses a webhook delivery. A
 * ledger that moves value is different: `adjust` and `reverses_entry_id` each
 * address one specific entry, and support quotes one back. schema.md now states
 * the test rather than the word.
 *
 * BITEMPORAL. `occurred_at_utc` is when it happened in the business sense — when
 * the comment was posted. `recorded_at_utc` is when we learned. Webhooks arrive
 * late and out of order, and without both a late arrival cannot be placed.
 */
@Entity('reward_ledger_entries')
export class RewardLedgerEntry extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  walletId!: number;

  @Column({ type: 'varchar', length: 20 })
  entryKind!: RewardEntryKind;

  /**
   * SIGNED. Whole points or minor units — the wallet's kind decides which.
   * Never a float, never a NUMERIC the application divides before storing.
   */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount!: number;

  /** The projection at this point, for audit. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  balanceAfter!: number;

  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  awardId!: number | null;

  /** WHICH RULE CAUSED THIS. The first question support asks. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  ruleId!: number | null;

  @Column({ type: 'int', nullable: true })
  ruleVersion!: number | null;

  /** Pairs the two legs of a conversion or a forward. */
  @Column({ type: 'uuid', nullable: true })
  groupRef!: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  reversesEntryId!: number | null;

  @Column({ type: 'text' })
  idempotencyKey!: string;

  /** For `adjust`: who. Must stand alone when Finance reads the ledger. */
  @Column({ type: 'varchar', length: 30, nullable: true })
  actorKind!: ActorKind | null;

  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  actorId!: number | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  reasonCode!: string | null;

  /** Business time. */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION })
  occurredAtUtc!: Date;

  /** System time. */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, default: () => 'now()' })
  recordedAtUtc!: Date;
}
