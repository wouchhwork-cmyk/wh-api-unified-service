import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RewardEntitlementRepository } from '@/database/repositories/reward-entitlement.repository';
import { RewardBenefitKind, Reversibility } from '@/shared/enums';
import type {
  AppliedBenefit,
  BenefitContext,
  CompensableBenefitHandler,
  BenefitOf,
} from './benefit.types';

/**
 * Codes a customer reads out at a till.
 *
 * Unambiguous alphabet: no O/0, no I/1. A code is transcribed by a person
 * under time pressure, and a digit that looks like a letter turns into a
 * support call.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

/**
 * 32^10 is about 1.1 x 10^15 — a random guess against a million issued codes
 * is roughly one in a billion. ENTROPY IS NOT A CONTROL ON ITS OWN; the unique
 * index refuses a collision and redemption will be rate-limited when it exists.
 *
 * NEVER DERIVED FROM THE CUSTOMER OR THE ITEM. A 2014 case saw a user replace
 * his referral code with a memorable one, seed it publicly, and collect over
 * $50,000 in credit from strangers.
 */
function generateRedemptionCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    // Non-null assertion is safe: randomBytes(n) always yields exactly n bytes.
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * An issued right, not a balance. A free coffee is not a number that goes up.
 *
 * NOT SCALABLE: 0.6 of a free coffee means nothing, so this kind refuses
 * `up_to` and the factor never touches it.
 */
@Injectable()
export class IssueEntitlementBenefit
  implements CompensableBenefitHandler<RewardBenefitKind.IssueEntitlement>
{
  readonly kind = RewardBenefitKind.IssueEntitlement as const;
  readonly scalable = false;
  readonly reversibility = Reversibility.Compensable as const;

  constructor(private readonly entitlements: RewardEntitlementRepository) {}

  async apply(
    benefit: BenefitOf<RewardBenefitKind.IssueEntitlement>,
    ctx: BenefitContext,
  ): Promise<AppliedBenefit> {
    const { itemRef, validForDays } = benefit.config;
    const expiresAt =
      validForDays === null
        ? null
        : new Date(ctx.occurredAtUtc.getTime() + validForDays * 24 * 60 * 60 * 1000);

    const issued = await this.entitlements.issue({
      enterpriseId: ctx.enterpriseId,
      customerId: ctx.customerId,
      awardId: ctx.awardId,
      itemRef,
      redemptionCode: generateRedemptionCode(),
      expiresAt,
    });

    return {
      payload: { itemRef, entitlementRefId: issued.refId },
      compensation: { entitlementId: issued.id },
    };
  }

  /**
   * Revokes it, if it has not been used.
   *
   * THE HONEST LIMIT: a REDEEMED entitlement cannot be taken back — the coffee
   * has been drunk. `revokeIfUnredeemed` guards on the current status and
   * returns false, and that is treated as success rather than an error,
   * because the award is still correctly reversed in every other respect and
   * failing the whole compensation would leave the points un-reversed too.
   *
   * This is the common shape of real compensation: it is rarely total.
   * Recording the attempt matters more than pretending it always works.
   */
  async compensate(applied: AppliedBenefit, ctx: BenefitContext): Promise<void> {
    const { entitlementId } = applied.compensation as { entitlementId: number };
    await this.entitlements.revokeIfUnredeemed(ctx.enterpriseId, entitlementId);
  }
}
