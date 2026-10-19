import { Injectable } from '@nestjs/common';
import { RewardConditionKind } from '@/shared/enums';
import { RewardConditionConfigSchema } from '@/shared/contracts/rewards/reward.contract';
import type {
  ConditionContext,
  ConditionHandler,
  ConditionHandlerMap,
  ConditionOf,
} from './condition.types';
import { ContentMatchCondition } from './content-match.condition';
import { CustomerTenureCondition } from './customer-tenure.condition';
import { TimeWindowCondition } from './time-window.condition';

/** What a rule's conditions decided, and WHICH one refused. */
export type ConditionOutcome =
  | { passed: true }
  | { passed: false; failedKind: RewardConditionKind };

/**
 * Every condition kind, mapped to its handler. Total, like the benefit map.
 */
@Injectable()
export class ConditionRegistry {
  private readonly handlers: ConditionHandlerMap;

  constructor(
    timeWindow: TimeWindowCondition,
    customerTenure: CustomerTenureCondition,
    contentMatch: ContentMatchCondition,
  ) {
    this.handlers = {
      [RewardConditionKind.TimeWindow]: timeWindow,
      [RewardConditionKind.CustomerTenure]: customerTenure,
      [RewardConditionKind.ContentMatch]: contentMatch,
    };
  }

  assertComplete(): void {
    const missing = Object.values(RewardConditionKind).filter(
      (kind) => this.handlers[kind] === undefined,
    );
    if (missing.length > 0) {
      throw new Error(`reward condition handlers not wired: ${missing.join(', ')}`);
    }
  }

  /**
   * Flat AND over the rule's conditions, cheapest first by index.
   *
   * AN EMPTY LIST PASSES. The absence of conditions means "always", never
   * "never" — the opposite would silently disable every rule nobody
   * configured, and storing rows with empty condition groups and no stated
   * meaning was one of the defects in the production coupon engine this
   * design was checked against.
   *
   * The failing kind is RETURNED, not just the boolean, so the award can
   * record `condition_failed:time_window` rather than a useless "a condition
   * failed". That is what preserves the diagnostic the old dedicated gate had.
   */
  evaluate(
    conditions: readonly { conditionKind: RewardConditionKind; config: Record<string, unknown> }[],
    ctx: ConditionContext,
  ): ConditionOutcome {
    for (const stored of conditions) {
      if (!this.checkOne(stored.conditionKind, stored.config, ctx)) {
        return { passed: false, failedKind: stored.conditionKind };
      }
    }
    return { passed: true };
  }

  /**
   * One condition, with the discriminant threaded through a generic.
   *
   * `this.handlers[kind].check(...)` does NOT compile: TypeScript takes the
   * union of every handler and intersects their parameter types down to
   * `never`. Making the method generic over K keeps the handler and the
   * condition provably the same kind, with no cast — which is the usual place
   * people give up and write `as any`.
   */
  private checkOne<K extends RewardConditionKind>(
    kind: K,
    config: Record<string, unknown>,
    ctx: ConditionContext,
  ): boolean {
    const handler: ConditionHandler<K> | undefined = this.handlers[kind];

    /*
     * FAIL CLOSED on an unknown kind — a rule naming a condition that has been
     * removed, or that is not deployed on this node yet.
     *
     * This matters more for us than for a discount engine: a mis-resolved rule
     * here GRANTS VALUE, where theirs merely withholds a discount.
     */
    if (handler === undefined) return false;

    /*
     * READ-TIME VALIDATION, and this is the layer nobody else implements.
     *
     * The stored config is JSONB, so the type system stops at the boundary.
     * Vendure coerces here instead and silently drops a renamed argument while
     * TypeScript asserts it is present — the exact divergence that put
     * `productIds` and `productId` in 58 rows of the coupon engine this design
     * was checked against.
     *
     * Parsing makes the narrowing below SOUND rather than asserted, and a
     * payload written before a schema change refuses loudly instead of
     * arriving half-empty.
     */
    const parsed = RewardConditionConfigSchema.safeParse({ conditionKind: kind, config });
    if (!parsed.success) return false;

    return handler.check(parsed.data as ConditionOf<K>, ctx);
  }
}
