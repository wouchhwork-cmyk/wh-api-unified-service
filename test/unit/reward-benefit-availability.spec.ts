import { describe, expect, it } from 'vitest';
import {
  BENEFIT_CATALOGUE,
  CreateRewardProgramSchema,
  CreateRewardRuleSchema,
} from '@/shared/contracts/rewards/reward.contract';
import { RewardAwardMode, RewardBenefitKind, RewardTriggerKind } from '@/shared/enums';

/**
 * Two rules about WHICH REWARDS MAY BE CHOSEN, and the reason each is here
 * rather than only on a screen.
 *
 * The portal greys both out. A screen is not the only way to reach this API,
 * and this codebase keeps rediscovering the same failure under new names: a
 * configuration that saves, reports success, and then awards nothing for ever.
 * These tests exist so the refusal is the contract's, not the form's.
 */
describe('which rewards may be chosen', () => {
  const PROGRAM = {
    name: 'Autumn',
    triggers: [RewardTriggerKind.DirectMessageInbound],
    schedule: { startsAt: null, endsAt: null, days: [] },
  };

  const points = {
    benefitKind: RewardBenefitKind.GrantPoints,
    awardMode: RewardAwardMode.Fixed,
    config: { points: 20 },
  };

  const conversion = {
    benefitKind: RewardBenefitKind.ConvertValue,
    awardMode: RewardAwardMode.Fixed,
    config: { burnPoints: 20, grantMinor: 200 },
  };

  /* ---------------------------------------------------------------- */
  /* An item has no catalogue behind it                                */
  /* ---------------------------------------------------------------- */

  it('refuses an item reward, which nothing can redeem yet', () => {
    const result = CreateRewardProgramSchema.safeParse({
      ...PROGRAM,
      benefits: [
        {
          benefitKind: RewardBenefitKind.IssueEntitlement,
          awardMode: RewardAwardMode.Fixed,
          config: { itemRef: 'FREE_COFFEE' },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('nothing behind it');
  });

  it('refuses it on the rule path too — the same rule by a different door', () => {
    const result = CreateRewardRuleSchema.safeParse({
      programRefId: '11111111-1111-4111-8111-111111111111',
      triggerKind: RewardTriggerKind.DirectMessageInbound,
      benefits: [
        {
          benefitKind: RewardBenefitKind.IssueEntitlement,
          awardMode: RewardAwardMode.Fixed,
          config: { itemRef: 'FREE_COFFEE' },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* A conversion needs the balance trigger                            */
  /* ---------------------------------------------------------------- */

  it('refuses a conversion hung off a social trigger', () => {
    const result = CreateRewardProgramSchema.safeParse({
      ...PROGRAM,
      benefits: [conversion],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('reached a points balance');
  });

  it('accepts a conversion on the balance trigger', () => {
    const result = CreateRewardProgramSchema.safeParse({
      ...PROGRAM,
      triggers: [RewardTriggerKind.PointsBalanceReached],
      minPointsBalance: 100,
      benefits: [conversion],
    });
    expect(result.success).toBe(true);
  });

  it('refuses a conversion on the rule path without the balance trigger', () => {
    const result = CreateRewardRuleSchema.safeParse({
      programRefId: '11111111-1111-4111-8111-111111111111',
      triggerKind: RewardTriggerKind.StoryMention,
      benefits: [conversion],
    });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* Rewards still need a trigger to hang off                          */
  /* ---------------------------------------------------------------- */

  it('refuses rewards with no trigger, which would be accepted and dropped', () => {
    /*
     * `createProgram` builds one rule PER TRIGGER. With no triggers there is
     * no rule, so these benefits were validated, returned in a 201, and never
     * stored anywhere — a programme that reported success and awards nothing.
     */
    const result = CreateRewardProgramSchema.safeParse({
      ...PROGRAM,
      triggers: [],
      benefits: [points],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('need a trigger');
  });

  it('still allows an empty shell: no triggers and no rewards', () => {
    const result = CreateRewardProgramSchema.safeParse({ ...PROGRAM, triggers: [], benefits: [] });
    expect(result.success).toBe(true);
  });

  /* ---------------------------------------------------------------- */
  /* Points are whole; money is minor units                            */
  /* ---------------------------------------------------------------- */

  it.each([
    ['a fraction of a point', { points: 2.5 }],
    ['a negative award', { points: -20 }],
    ['nothing at all', { points: 0 }],
  ])('refuses %s', (_label, config) => {
    const result = CreateRewardProgramSchema.safeParse({
      ...PROGRAM,
      benefits: [{ ...points, config }],
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ['a fraction of a minor unit', { burnPoints: 20, grantMinor: 200.5 }],
    ['a fraction of a point to burn', { burnPoints: 20.5, grantMinor: 200 }],
    ['negative money', { burnPoints: 20, grantMinor: -200 }],
  ])('refuses %s in a conversion', (_label, config) => {
    const result = CreateRewardProgramSchema.safeParse({
      ...PROGRAM,
      triggers: [RewardTriggerKind.PointsBalanceReached],
      minPointsBalance: 100,
      benefits: [{ ...conversion, config }],
    });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* Two rewards that do the same thing are one reward written twice   */
  /* ---------------------------------------------------------------- */

  it('refuses two points rewards, which are one bigger grant', () => {
    const result = CreateRewardProgramSchema.safeParse({
      ...PROGRAM,
      benefits: [points, { ...points, config: { points: 30 } }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('do the same thing');
  });

  it('refuses two money rewards in the same currency', () => {
    const money = {
      benefitKind: RewardBenefitKind.GrantCurrency,
      awardMode: RewardAwardMode.Fixed,
      config: { minorUnits: 500, currencyCode: 'INR' },
    };
    const result = CreateRewardProgramSchema.safeParse({
      ...PROGRAM,
      benefits: [money, { ...money, config: { minorUnits: 250, currencyCode: 'INR' } }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a stated currency twice even written differently', () => {
    const result = CreateRewardProgramSchema.safeParse({
      ...PROGRAM,
      benefits: [
        {
          benefitKind: RewardBenefitKind.GrantCurrency,
          awardMode: RewardAwardMode.Fixed,
          config: { minorUnits: 500, currencyCode: 'USD' },
        },
        {
          benefitKind: RewardBenefitKind.GrantCurrency,
          awardMode: RewardAwardMode.UpTo,
          awardCap: 250,
          config: { minorUnits: 250, currencyCode: 'USD' },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  /*
   * THE CASE THIS MUST NOT BREAK. Two currency grants in DIFFERENT currencies
   * pay into two different wallets, which is two rewards and not one written
   * twice — so the rule keys on the effect rather than on the kind.
   */
  it('accepts two money rewards in different currencies', () => {
    const result = CreateRewardProgramSchema.safeParse({
      ...PROGRAM,
      benefits: [
        {
          benefitKind: RewardBenefitKind.GrantCurrency,
          awardMode: RewardAwardMode.Fixed,
          config: { minorUnits: 500, currencyCode: 'INR' },
        },
        {
          benefitKind: RewardBenefitKind.GrantCurrency,
          awardMode: RewardAwardMode.Fixed,
          config: { minorUnits: 600, currencyCode: 'USD' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('still accepts points alongside money — different effects entirely', () => {
    const result = CreateRewardProgramSchema.safeParse({
      ...PROGRAM,
      benefits: [
        points,
        {
          benefitKind: RewardBenefitKind.GrantCurrency,
          awardMode: RewardAwardMode.Fixed,
          config: { minorUnits: 500 },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('refuses the duplicate on the rule path too', () => {
    const result = CreateRewardRuleSchema.safeParse({
      programRefId: '11111111-1111-4111-8111-111111111111',
      triggerKind: RewardTriggerKind.DirectMessageInbound,
      benefits: [points, { ...points, config: { points: 30 } }],
    });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* The catalogue is the one the portal renders from                  */
  /* ---------------------------------------------------------------- */

  it('names every benefit kind exactly once', () => {
    const keys = BENEFIT_CATALOGUE.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(Object.values(RewardBenefitKind)));
  });
});
