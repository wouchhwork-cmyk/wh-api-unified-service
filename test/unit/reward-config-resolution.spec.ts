import { describe, expect, it } from 'vitest';
import { RewardBenefitConfigSchema } from '@/shared/contracts/rewards/reward.contract';
import { scaleByFactor } from '@/modules/rewards/factor.provider';
import { RewardBenefitKind } from '@/shared/enums';

/**
 * Two bugs that reached the grant path and would have fired in production.
 *
 * Both are about the shape of a resolved benefit payload, which is the one
 * place the type system genuinely stops: the config is JSONB, so only a parse
 * says whether it is right.
 */
describe('resolved benefit payloads', () => {
  /**
   * BUG ONE, and it broke the ordinary case.
   *
   * The program's default currency was being injected into EVERY benefit
   * config, including points. The schemas are strictObject, so a points rule
   * inside a program with a default currency — which is what the portal
   * creates — threw on every grant.
   */
  it('rejects a points payload carrying a currency', () => {
    const bad = RewardBenefitConfigSchema.safeParse({
      benefitKind: RewardBenefitKind.GrantPoints,
      config: { points: 20, currencyCode: 'INR' },
    });
    expect(bad.success).toBe(false);

    const good = RewardBenefitConfigSchema.safeParse({
      benefitKind: RewardBenefitKind.GrantPoints,
      config: { points: 20 },
    });
    expect(good.success).toBe(true);
  });

  /**
   * A money payload may omit its currency, and that now MEANS something:
   * the business's own.
   *
   * This asserted the opposite — that a currency was required here — which
   * made the business-level setting unable to be the answer to anything.
   * Every benefit had to repeat it, and a business changing currency would
   * have had to edit every rule it owns. A rule that omits it and belongs to
   * a business with no currency is refused at CREATION with
   * `ENTERPRISE_CURRENCY_NOT_SET`, which is a different layer's job.
   */
  it('lets a money payload omit its currency, meaning the business’s own', () => {
    const withoutCurrency = RewardBenefitConfigSchema.safeParse({
      benefitKind: RewardBenefitKind.GrantCurrency,
      config: { minorUnits: 5000 },
    });
    expect(withoutCurrency.success).toBe(true);

    const withCurrency = RewardBenefitConfigSchema.safeParse({
      benefitKind: RewardBenefitKind.GrantCurrency,
      config: { minorUnits: 5000, currencyCode: 'INR' },
    });
    expect(withCurrency.success).toBe(true);
  });

  /**
   * THE CHECK THAT USED TO BE A SHAPE. `/^[A-Z]{3}$/` describes what a
   * currency code looks like rather than testing whether it is one, so `XYZ`
   * was accepted and stored and a wallet could be opened in a currency that
   * does not exist — with nothing downstream to reconcile it against.
   */
  it('refuses a three-letter code that is not a real currency', () => {
    for (const code of ['XYZ', 'ABC', 'ZZZ']) {
      const parsed = RewardBenefitConfigSchema.safeParse({
        benefitKind: RewardBenefitKind.GrantCurrency,
        config: { minorUnits: 5000, currencyCode: code },
      });
      expect(parsed.success, `${code} must be refused`).toBe(false);
    }
  });

  /** Case is a typing convenience, not a different currency. */
  it('accepts a real currency in any case and stores it upper', () => {
    const parsed = RewardBenefitConfigSchema.safeParse({
      benefitKind: RewardBenefitKind.GrantCurrency,
      config: { minorUnits: 5000, currencyCode: 'inr' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data.config as { currencyCode?: string }).currencyCode).toBe('INR');
    }
  });

  /**
   * BUG TWO, latent until a real factor engine lands.
   *
   * A cap of 1 with a factor of 0.4 rounds to zero, and every amount schema
   * requires a positive number — so the award would have THROWN on a payload
   * that is simply not worth granting. It takes the zero-factor path instead:
   * nothing awarded, cap slot handed back.
   */
  it('scales a small cap to nothing at a low factor', () => {
    expect(scaleByFactor(1, 4000)).toBe(0);

    const zeroed = RewardBenefitConfigSchema.safeParse({
      benefitKind: RewardBenefitKind.GrantPoints,
      config: { points: scaleByFactor(1, 4000) },
    });
    expect(zeroed.success).toBe(false);
  });

  it('keeps a cap of one at a factor above a half', () => {
    expect(scaleByFactor(1, 5000)).toBe(1);
    expect(scaleByFactor(1, 10000)).toBe(1);
  });

  /** An unknown key is a typo or a stale client, never something to discard. */
  it('refuses an unknown key rather than dropping it', () => {
    const result = RewardBenefitConfigSchema.safeParse({
      benefitKind: RewardBenefitKind.GrantPoints,
      config: { points: 20, pointz: 99 },
    });
    expect(result.success).toBe(false);
  });

  /** The renamed-argument failure that discredited the coupon engine. */
  it('refuses a payload whose key was renamed under it', () => {
    const stale = RewardBenefitConfigSchema.safeParse({
      benefitKind: RewardBenefitKind.IssueEntitlement,
      config: { itemRefs: ['COFFEE'], validForDays: null },
    });
    expect(stale.success).toBe(false);
  });
});
