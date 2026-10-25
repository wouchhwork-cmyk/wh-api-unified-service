import { Injectable } from '@nestjs/common';
import { RewardWalletRepository } from '@/database/repositories/reward-wallet.repository';
import {
  RewardBenefitKind,
  RewardEntryKind,
  RewardWalletKind,
  Reversibility,
} from '@/shared/enums';
import type {
  AppliedBenefit,
  BenefitContext,
  CompensableBenefitHandler,
  BenefitOf,
} from './benefit.types';

/**
 * Whole points into the customer's points wallet.
 *
 * SCALABLE: 0.6 x 20 = 12 points means something, so this kind may be `up_to`
 * and let the factor decide the amount.
 */
@Injectable()
export class GrantPointsBenefit
  implements CompensableBenefitHandler<RewardBenefitKind.GrantPoints>
{
  readonly kind = RewardBenefitKind.GrantPoints as const;
  readonly scalable = true;
  readonly reversibility = Reversibility.Compensable as const;

  constructor(private readonly wallets: RewardWalletRepository) {}

  async apply(
    benefit: BenefitOf<RewardBenefitKind.GrantPoints>,
    ctx: BenefitContext,
  ): Promise<AppliedBenefit> {
    const wallet = await this.wallets.ensureCustomerWallet({
      enterpriseId: ctx.enterpriseId,
      customerId: ctx.customerId,
      walletKind: RewardWalletKind.Points,
      currencyCode: null,
    });

    const entry = await this.wallets.credit({
      enterpriseId: ctx.enterpriseId,
      walletId: wallet.id,
      entryKind: RewardEntryKind.Earn,
      amount: benefit.config.points,
      idempotencyKey: ctx.idempotencyKey,
      occurredAtUtc: ctx.occurredAtUtc,
      awardId: ctx.awardId,
      ruleId: ctx.ruleId,
      ruleVersion: ctx.ruleVersion,
    });

    return {
      payload: { points: benefit.config.points },
      compensation: { entryId: entry.id, walletId: wallet.id, points: benefit.config.points },
    };
  }

  /**
   * A reversing entry, never an edit of the original.
   *
   * THE BALANCE MAY GO NEGATIVE, and that is correct rather than a failure: the
   * customer may already have spent or converted the points. Negative is real
   * debt — it takes effect immediately, never expires, and the next earn
   * offsets it.
   */
  async compensate(applied: AppliedBenefit, ctx: BenefitContext): Promise<void> {
    const { entryId, walletId, points } = applied.compensation as {
      entryId: number;
      walletId: number;
      points: number;
    };
    await this.wallets.postUnchecked({
      enterpriseId: ctx.enterpriseId,
      walletId,
      entryKind: RewardEntryKind.Reversal,
      amount: -points,
      idempotencyKey: `${ctx.idempotencyKey}:reversal`,
      occurredAtUtc: ctx.occurredAtUtc,
      awardId: ctx.awardId,
      ruleId: ctx.ruleId,
      reversesEntryId: entryId,
      reasonCode: 'benefit_compensated',
    });
  }
}
