import { randomUUID } from 'node:crypto';
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

/** Nothing good comes of an unbounded conversion loop on a hot path. */
const MAX_CONVERSIONS_PER_APPLY = 100;

/**
 * Points become money. Burn then earn, in one transaction.
 *
 * NOT A LOT MOVE. The points are destroyed and the currency is created, which
 * is what every loyalty platform does for a transfer, and it is why the two
 * legs share a `group_ref` rather than being one row.
 *
 * NOT SCALABLE: a conversion is a stated exchange rate. Letting a factor shave
 * it would mean 30 points sometimes bought ₹50 and sometimes ₹30, which is not
 * a thing an enterprise can explain to a customer.
 */
@Injectable()
export class ConvertValueBenefit
  implements CompensableBenefitHandler<RewardBenefitKind.ConvertValue>
{
  readonly kind = RewardBenefitKind.ConvertValue as const;
  readonly scalable = false;
  readonly reversibility = Reversibility.Compensable as const;

  constructor(private readonly wallets: RewardWalletRepository) {}

  async apply(
    benefit: BenefitOf<RewardBenefitKind.ConvertValue>,
    ctx: BenefitContext,
  ): Promise<AppliedBenefit> {
    const { burnPoints, grantMinor, currencyCode } = benefit.config;

    const pointsWallet = await this.wallets.ensureCustomerWallet({
      enterpriseId: ctx.enterpriseId,
      customerId: ctx.customerId,
      walletKind: RewardWalletKind.Points,
      currencyCode: null,
    });

    /*
     * How many whole conversions the balance affords, computed ONCE.
     *
     * Not a `while (balance >= threshold)` loop: that is unbounded on a hot
     * path, which our own guidelines forbid outright. The cap is a second
     * belt — a balance that somehow allowed 10,000 conversions is a bug worth
     * stopping rather than faithfully executing.
     */
    const affordable = Math.floor(pointsWallet.balance / burnPoints);
    const times = Math.min(affordable, MAX_CONVERSIONS_PER_APPLY);
    if (times < 1) {
      throw new InsufficientPointsError(burnPoints, pointsWallet.balance);
    }

    const groupRef = randomUUID();
    const totalBurn = times * burnPoints;
    const totalGrant = times * grantMinor;

    /*
     * The burn is the conditional statement, so a concurrent conversion cannot
     * spend the same points twice. Zero rows means the balance moved under us
     * between the read above and this write — the whole award then fails and
     * rolls back, which is the correct outcome rather than converting anyway.
     */
    const burned = await this.wallets.debitIfSufficient({
      enterpriseId: ctx.enterpriseId,
      walletId: pointsWallet.id,
      entryKind: RewardEntryKind.ConvertOut,
      amount: -totalBurn,
      idempotencyKey: `${ctx.idempotencyKey}:out`,
      occurredAtUtc: ctx.occurredAtUtc,
      awardId: ctx.awardId,
      ruleId: ctx.ruleId,
      ruleVersion: ctx.ruleVersion,
      groupRef,
    });
    if (!burned) {
      throw new InsufficientPointsError(totalBurn, pointsWallet.balance);
    }

    const currencyWallet = await this.wallets.ensureCustomerWallet({
      enterpriseId: ctx.enterpriseId,
      customerId: ctx.customerId,
      walletKind: RewardWalletKind.Currency,
      currencyCode,
    });

    const granted = await this.wallets.credit({
      enterpriseId: ctx.enterpriseId,
      walletId: currencyWallet.id,
      entryKind: RewardEntryKind.ConvertIn,
      amount: totalGrant,
      idempotencyKey: `${ctx.idempotencyKey}:in`,
      occurredAtUtc: ctx.occurredAtUtc,
      awardId: ctx.awardId,
      ruleId: ctx.ruleId,
      ruleVersion: ctx.ruleVersion,
      groupRef,
    });

    return {
      payload: { times, burnedPoints: totalBurn, grantedMinor: totalGrant, currencyCode },
      compensation: {
        groupRef,
        pointsWalletId: pointsWallet.id,
        currencyWalletId: currencyWallet.id,
        burnedPoints: totalBurn,
        grantedMinor: totalGrant,
        outEntryId: burned.id,
        inEntryId: granted.id,
      },
    };
  }

  /** Both legs come back, paired by a fresh group so the audit trail reads. */
  async compensate(applied: AppliedBenefit, ctx: BenefitContext): Promise<void> {
    const c = applied.compensation as {
      pointsWalletId: number;
      currencyWalletId: number;
      burnedPoints: number;
      grantedMinor: number;
      outEntryId: number;
      inEntryId: number;
    };
    const groupRef = randomUUID();

    // Currency first: taking back what was given before returning what was
    // taken keeps the customer from briefly holding both.
    await this.wallets.postUnchecked({
      enterpriseId: ctx.enterpriseId,
      walletId: c.currencyWalletId,
      entryKind: RewardEntryKind.Reversal,
      amount: -c.grantedMinor,
      idempotencyKey: `${ctx.idempotencyKey}:in:reversal`,
      occurredAtUtc: ctx.occurredAtUtc,
      awardId: ctx.awardId,
      groupRef,
      reversesEntryId: c.inEntryId,
      reasonCode: 'conversion_reversed',
    });

    await this.wallets.postUnchecked({
      enterpriseId: ctx.enterpriseId,
      walletId: c.pointsWalletId,
      entryKind: RewardEntryKind.Reversal,
      amount: c.burnedPoints,
      idempotencyKey: `${ctx.idempotencyKey}:out:reversal`,
      occurredAtUtc: ctx.occurredAtUtc,
      awardId: ctx.awardId,
      groupRef,
      reversesEntryId: c.outEntryId,
      reasonCode: 'conversion_reversed',
    });
  }
}

/** Not enough points. A refusal, not a failure — the award simply does not grant. */
export class InsufficientPointsError extends Error {
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super(`conversion needs ${required} points, balance is ${available}`);
    this.name = 'InsufficientPointsError';
  }
}
