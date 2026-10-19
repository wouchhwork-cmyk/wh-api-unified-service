import { describe, expect, it } from 'vitest';
import {
  CreateRewardRuleSchema,
  RewardTriggerConfigSchema,
} from '@/shared/contracts/rewards/reward.contract';
import { matchesTriggerConfig } from '@/modules/rewards/trigger-match.util';
import { RewardAwardMode, RewardBenefitKind, RewardTriggerKind } from '@/shared/enums';

/**
 * The trigger config: accepted, stored, read back — and, until now, matched by
 * NOTHING.
 *
 * A business could scope a rule to one channel, see the scope saved, and have
 * it fire on every channel they own. The tests below are the two halves of the
 * fix: a strict shape on the way in, and a matcher that reads it on the way
 * out.
 */
describe('trigger config', () => {
  const RULE = {
    programRefId: '11111111-1111-4111-8111-111111111111',
    benefits: [
      {
        benefitKind: RewardBenefitKind.GrantPoints,
        awardMode: RewardAwardMode.Fixed,
        config: { points: 20 },
      },
    ],
  };

  it('refuses a key the engine does not read', () => {
    const parsed = RewardTriggerConfigSchema.safeParse({ postbackPayload: 'WELCOME' });
    expect(parsed.success).toBe(false);
  });

  /**
   * A THRESHOLD TRIGGER WITH NO THRESHOLD FIRES AT ANY BALANCE ABOVE ZERO.
   *
   * This is the defect the refinement exists for, and it spends a real budget:
   * every credit would re-offer the balance and the conversion rule would take
   * it every time.
   */
  it('requires a threshold on the balance trigger', () => {
    const bad = CreateRewardRuleSchema.safeParse({
      ...RULE,
      triggerKind: RewardTriggerKind.PointsBalanceReached,
      triggerConfig: {},
    });
    expect(bad.success).toBe(false);

    const good = CreateRewardRuleSchema.safeParse({
      ...RULE,
      triggerKind: RewardTriggerKind.PointsBalanceReached,
      triggerConfig: { minPointsBalance: 100 },
    });
    expect(good.success).toBe(true);
  });

  /** The other direction: a threshold on a comment rule would never be applied. */
  it('refuses a threshold on a trigger that cannot use one', () => {
    const parsed = CreateRewardRuleSchema.safeParse({
      ...RULE,
      triggerKind: RewardTriggerKind.CommentOnOwnPost,
      triggerConfig: { minPointsBalance: 100 },
    });
    expect(parsed.success).toBe(false);
  });

  /** A balance crossing happens in no channel, so scoping one matches nothing. */
  it('refuses channel scoping on the balance trigger', () => {
    const parsed = CreateRewardRuleSchema.safeParse({
      ...RULE,
      triggerKind: RewardTriggerKind.PointsBalanceReached,
      triggerConfig: { minPointsBalance: 100, channelIds: [7] },
    });
    expect(parsed.success).toBe(false);
  });

  it('leaves an empty config matching everything', () => {
    expect(matchesTriggerConfig({}, { channelId: 7, pointsBalance: null })).toBe(true);
    expect(matchesTriggerConfig({}, { channelId: null, pointsBalance: null })).toBe(true);
  });

  it('matches only the listed channels', () => {
    const config = { channelIds: [7, 9] };
    expect(matchesTriggerConfig(config, { channelId: 7, pointsBalance: null })).toBe(true);
    expect(matchesTriggerConfig(config, { channelId: 8, pointsBalance: null })).toBe(false);
  });

  /**
   * NO CHANNEL IS NOT EVERY CHANNEL.
   *
   * Reading a null channel as a wildcard would turn the narrowest rule in the
   * program into the widest one.
   */
  it('refuses an event with no channel against a channel list', () => {
    expect(
      matchesTriggerConfig({ channelIds: [7] }, { channelId: null, pointsBalance: null }),
    ).toBe(false);
  });

  it('fires at the threshold and above it, never below', () => {
    const config = { minPointsBalance: 100 };
    expect(matchesTriggerConfig(config, { channelId: null, pointsBalance: 99 })).toBe(false);
    expect(matchesTriggerConfig(config, { channelId: null, pointsBalance: 100 })).toBe(true);
    expect(matchesTriggerConfig(config, { channelId: null, pointsBalance: 250 })).toBe(true);
  });

  /**
   * FAILS CLOSED, which is what makes the producer the only way in.
   *
   * Every path except a credit passes a null balance. If that read as a match,
   * one inbound message would fire every threshold rule in the program.
   */
  it('refuses a threshold rule when the balance is unknown', () => {
    expect(
      matchesTriggerConfig({ minPointsBalance: 100 }, { channelId: null, pointsBalance: null }),
    ).toBe(false);
  });
});
