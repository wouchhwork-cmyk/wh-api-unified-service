import type { RewardConditionConfig } from '@/shared/contracts/rewards/reward.contract';
import type { RewardConditionKind } from '@/shared/enums';

export type RewardCondition = RewardConditionConfig;
export type ConditionOf<K extends RewardConditionKind> = Extract<
  RewardCondition,
  { conditionKind: K }
>;

/**
 * What a condition gets to look at.
 *
 * Deliberately NOT the database. A condition is a pure function over an event
 * that is already loaded, which is what makes it unit-testable without a
 * database and keeps it out of the claim query.
 */
export interface ConditionContext {
  readonly enterpriseId: number;
  readonly customerId: number;
  /** When the customer ACTED. Never now(), never when we learned. */
  readonly occurredAtUtc: Date;
  /** The program's IANA zone. Every wall-clock comparison resolves through it. */
  /** NULL = the business has not set one. A condition needing a calendar
   * day fails CLOSED rather than guessing at one. */
  readonly timezone: string | null;
  /** Comment body or post caption, where the trigger has one. */
  readonly content: string | null;
  /** First time we ever saw this customer, for tenure checks. */
  readonly customerFirstSeenAt: Date | null;
}

export interface ConditionHandler<K extends RewardConditionKind> {
  readonly kind: K;
  check(condition: ConditionOf<K>, ctx: ConditionContext): boolean;
}

/** Total, for the same reason the benefit map is. */
export type ConditionHandlerMap = {
  readonly [K in RewardConditionKind]: ConditionHandler<K>;
};
