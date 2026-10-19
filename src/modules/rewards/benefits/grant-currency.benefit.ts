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
 * Minor units into the customer's wallet for that currency.
 *
 * ONE WALLET PER CURRENCY, never netted. A customer holding ₹250 and $12 holds
 * two numbers; collapsing them into one would be wrong in every screen, API
 * response and export. There is no implicit FX anywhere in this path.
 */
@Injectable()
export class GrantCurrencyBenefit
  implements CompensableBenefitHandler<RewardBenefitKind.GrantCurrency>
{
  readonly kind = RewardBenefitKind.GrantCurrency as const;
  readonly scalable = true;
  readonly reversibility = Reversibility.Compensable as const;

  constructor(private readonly wallets: RewardWalletRepository) {}

  async apply(
    benefit: BenefitOf<RewardBenefitKind.GrantCurrency>,
    ctx: BenefitContext,
  ): Promise<AppliedBenefit> {
    const wallet = await this.wallets.ensureCustomerWallet({
      enterpriseId: ctx.enterpriseId,
      customerId: ctx.customerId,
      walletKind: RewardWalletKind.Currency,
      currencyCode: benefit.config.currencyCode,
    });

    const entry = await this.wallets.credit({
      enterpriseId: ctx.enterpriseId,
      walletId: wallet.id,
      entryKind: RewardEntryKind.Earn,
      amount: benefit.config.minorUnits,
      idempotencyKey: ctx.idempotencyKey,
      occurredAtUtc: ctx.occurredAtUtc,
      awardId: ctx.awardId,
      ruleId: ctx.ruleId,
      ruleVersion: ctx.ruleVersion,
    });

    return {
      payload: {
        minorUnits: benefit.config.minorUnits,
        currencyCode: benefit.config.currencyCode,
      },
      compensation: {
        entryId: entry.id,
        walletId: wallet.id,
        minorUnits: benefit.config.minorUnits,
      },
    };
  }

  async compensate(applied: AppliedBenefit, ctx: BenefitContext): Promise<void> {
    const { entryId, walletId, minorUnits } = applied.compensation as {
      entryId: number;
      walletId: number;
      minorUnits: number;
    };
    await this.wallets.postUnchecked({
      enterpriseId: ctx.enterpriseId,
      walletId,
      entryKind: RewardEntryKind.Reversal,
      amount: -minorUnits,
      idempotencyKey: `${ctx.idempotencyKey}:reversal`,
      occurredAtUtc: ctx.occurredAtUtc,
      awardId: ctx.awardId,
      ruleId: ctx.ruleId,
      reversesEntryId: entryId,
      reasonCode: 'benefit_compensated',
    });
  }
}
