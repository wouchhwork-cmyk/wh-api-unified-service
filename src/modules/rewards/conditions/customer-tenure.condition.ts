import { Injectable } from '@nestjs/common';
import { RewardConditionKind } from '@/shared/enums';
import type { ConditionContext, ConditionHandler, ConditionOf } from './condition.types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * "Must have been our customer for a while."
 *
 * The cheapest abuse control available, and it costs no new data: we already
 * know when a customer first engaged. A brand-new account farming a reward is
 * the laziest version of the attack, and this stops it without touching device
 * fingerprints or an identity graph.
 *
 * FAILS CLOSED on an unknown first-seen date. A customer we cannot date is one
 * we cannot vouch for, and granting value to them by default is the wrong way
 * round for a control whose whole purpose is caution.
 */
@Injectable()
export class CustomerTenureCondition
  implements ConditionHandler<RewardConditionKind.CustomerTenure>
{
  readonly kind = RewardConditionKind.CustomerTenure as const;

  check(
    condition: ConditionOf<RewardConditionKind.CustomerTenure>,
    ctx: ConditionContext,
  ): boolean {
    if (ctx.customerFirstSeenAt === null) return false;
    const ageDays = (ctx.occurredAtUtc.getTime() - ctx.customerFirstSeenAt.getTime()) / MS_PER_DAY;
    return ageDays >= condition.config.minDaysSinceFirstEngagement;
  }
}
