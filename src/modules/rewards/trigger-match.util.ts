import type { RewardTriggerConfig } from '@/shared/contracts/rewards/reward.contract';

/** The event facts a trigger config is matched against. Nothing else is read. */
export interface TriggerMatchFacts {
  readonly channelId: number | null;
  /** The points balance after the credit, where one is known. */
  readonly pointsBalance: number | null;
}

/**
 * Does the rule's own narrowing match this event?
 *
 * Pure, so the awkward cases are testable without a database: the SQL matched
 * the trigger KIND and this matches what the business narrowed it to. Before it
 * existed the config was accepted, stored and read back while being matched by
 * nothing, so a rule scoped to one channel fired on all of them.
 */
export function matchesTriggerConfig(
  config: RewardTriggerConfig,
  facts: TriggerMatchFacts,
): boolean {
  const { channelIds, minPointsBalance } = config;

  /*
   * An event with no channel cannot satisfy a channel list. Reading "no
   * channel" as "any channel" would turn the narrowest rule into the widest.
   */
  if (channelIds && (facts.channelId === null || !channelIds.includes(facts.channelId))) {
    return false;
  }

  /*
   * FAILS CLOSED on an unknown balance. Only the post-credit producer carries
   * one, so a threshold rule reached by any other path refuses rather than
   * firing on a balance nobody read.
   */
  if (minPointsBalance !== undefined) {
    if (facts.pointsBalance === null) return false;
    if (facts.pointsBalance < minPointsBalance) return false;
  }

  return true;
}
