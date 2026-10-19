import { Injectable } from '@nestjs/common';
import { RewardConditionKind } from '@/shared/enums';
import type { ConditionContext, ConditionHandler, ConditionOf } from './condition.types';

/**
 * A keyword in the comment body or the post caption.
 *
 * Case-insensitive, and a plain substring test rather than a regular
 * expression. A tenant-authored regex is an unbounded computation on a hot
 * path — catastrophic backtracking is a denial of service written by a
 * customer with no idea they wrote one. If patterns are ever genuinely needed
 * they arrive as a separate condition kind with a bounded engine, not by
 * loosening this one.
 *
 * FAILS CLOSED where the trigger carries no text. A story mention has no body,
 * so a keyword condition on one can never be satisfied — which is correct, and
 * the UI should not offer the pairing.
 */
@Injectable()
export class ContentMatchCondition implements ConditionHandler<RewardConditionKind.ContentMatch> {
  readonly kind = RewardConditionKind.ContentMatch as const;

  check(condition: ConditionOf<RewardConditionKind.ContentMatch>, ctx: ConditionContext): boolean {
    if (ctx.content === null || ctx.content.trim() === '') return false;
    const haystack = ctx.content.toLowerCase();
    return condition.config.anyOfKeywords.some((word) => haystack.includes(word.toLowerCase()));
  }
}
