import { Column, Entity } from 'typeorm';
import { RewardAccountKind, RewardWalletKind } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * reward-programs-design.md §8.7 — one balance per kind per currency.
 *
 * A CUSTOMER HOLDS SEVERAL AT ONCE: 340 points, ₹250 and $12 simultaneously is
 * the normal case. Three invariants follow and none is negotiable —
 *
 *   1. NEVER NET ACROSS WALLETS. There is no "total balance". Any screen, API
 *      or export that collapses them into one number is wrong.
 *   2. Minor-unit scale comes from the ISO 4217 exponent, never a constant.
 *      JPY/KRW/VND are 0, INR/USD are 2, KWD/BHD are 3.
 *   3. No implicit FX. Nothing here converts one currency into another.
 *
 * `balance` is a PROJECTION of the ledger, written in the same transaction as
 * the entry and reconciled by a job. The ledger is the record.
 *
 * Two system kinds have no customer. `system_transit` holds value forwarded and
 * not yet confirmed; it must drain to approximately zero, and a balance that
 * does not is a stuck forward somebody can see.
 */
@Entity('reward_wallets')
export class RewardWallet extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'varchar', length: 20, default: RewardAccountKind.Customer })
  accountKind!: RewardAccountKind;

  /** NULL for the two house kinds. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  customerId!: number | null;

  /** Set for transit and external; names the program whose forward it holds. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  destinationProgramId!: number | null;

  /** Decides how `balance` is READ: whole points, or minor units. */
  @Column({ type: 'varchar', length: 16 })
  walletKind!: RewardWalletKind;

  /** NULL for points; ISO 4217 for currency. */
  @Column({ type: 'char', length: 3, nullable: true })
  currencyCode!: string | null;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  balance!: number;

  /** Held, not yet spendable. */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  pendingBalance!: number;

  /** NEVER decremented. What a tier would read, if tiers ever arrive. */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  lifetimeEarned!: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  version!: number;
}
