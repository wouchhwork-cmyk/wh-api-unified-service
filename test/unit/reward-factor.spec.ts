import { describe, expect, it } from 'vitest';
import {
  ConstantOneFactorProvider,
  FactorEvaluator,
  scaleByFactor,
} from '@/modules/rewards/factor.provider';
import { FACTOR_BASIS_POINTS_MAX } from '@/shared/enums';

const ctx = {
  enterpriseId: 1,
  customerId: 1,
  ruleId: 1,
  occurredAtUtc: new Date('2026-10-19T10:00:00Z'),
};

describe('scaleByFactor', () => {
  it('pays the full cap at 1.0', () => {
    expect(scaleByFactor(20, FACTOR_BASIS_POINTS_MAX)).toBe(20);
  });

  it('pays nothing at 0', () => {
    expect(scaleByFactor(20, 0)).toBe(0);
  });

  it('scales proportionally', () => {
    expect(scaleByFactor(20, 6000)).toBe(12);
    expect(scaleByFactor(100, 2500)).toBe(25);
  });

  /**
   * ROUNDS HALF UP, not down.
   *
   * 7 x 0.65 is 4.55. Flooring would pay 4 and quietly shortchange the
   * customer on every award that lands on a fraction, which over a campaign is
   * a systematic bias in the enterprise's favour that nobody asked for.
   */
  it('rounds half up rather than truncating', () => {
    expect(scaleByFactor(7, 6500)).toBe(5);
    expect(scaleByFactor(3, 5000)).toBe(2);
  });

  it('never exceeds the cap', () => {
    for (const bp of [0, 1, 4999, 5000, 9999, FACTOR_BASIS_POINTS_MAX]) {
      expect(scaleByFactor(20, bp)).toBeLessThanOrEqual(20);
    }
  });
});

describe('FactorEvaluator', () => {
  const evaluator = new FactorEvaluator(new ConstantOneFactorProvider());

  it('returns a full factor from constant_one', async () => {
    const result = await evaluator.evaluate('constant_one', ctx);
    expect(result.basisPoints).toBe(FACTOR_BASIS_POINTS_MAX);
    expect(result.inputs).toMatchObject({ provider: 'constant_one', raw: 1 });
  });

  /**
   * FAILS CLOSED on an unknown provider.
   *
   * A rule naming a provider this node does not have must award nothing rather
   * than default to full — a mis-resolved rule here GRANTS VALUE, where a
   * discount engine would merely withhold a discount.
   */
  it('scores zero for a provider it does not know', async () => {
    const result = await evaluator.evaluate('some_future_engine', ctx);
    expect(result.basisPoints).toBe(0);
    expect(result.inputs).toMatchObject({ error: 'unknown_provider' });
  });

  /**
   * THE CLAMP IS AT THE BOUNDARY, not inside the provider.
   *
   * A provider returning 1.5 must not pay 30 against a cap of 20. The provider
   * is the thing most likely to change, so the guard lives where it is called.
   */
  it('clamps a provider that returns more than one', async () => {
    const overeager = { code: 'overeager', factor: () => Promise.resolve(1.5) };
    const result = await new FactorEvaluator(overeager as never).evaluate('overeager', ctx);
    expect(result.basisPoints).toBe(FACTOR_BASIS_POINTS_MAX);
    expect(scaleByFactor(20, result.basisPoints)).toBe(20);
  });

  it('clamps a provider that returns a negative', async () => {
    const negative = { code: 'negative', factor: () => Promise.resolve(-3) };
    const result = await new FactorEvaluator(negative as never).evaluate('negative', ctx);
    expect(result.basisPoints).toBe(0);
  });

  it('scores zero for a non-finite factor', async () => {
    const broken = { code: 'broken', factor: () => Promise.resolve(Number.NaN) };
    const result = await new FactorEvaluator(broken as never).evaluate('broken', ctx);
    expect(result.basisPoints).toBe(0);
    expect(result.inputs).toMatchObject({ error: 'non_finite_factor' });
  });

  /**
   * A SCORING ENGINE FALLING OVER MUST NOT TAKE THE GRANT PATH DOWN.
   *
   * The award records skipped_zero_factor and the customer keeps their cap
   * slot, which is recoverable. An exception propagating out of here would
   * fail the whole award transaction instead.
   */
  it('treats a thrown error as zero rather than propagating', async () => {
    const thrower = {
      code: 'thrower',
      factor: () => Promise.reject(new Error('scoring service unreachable')),
    };
    const result = await new FactorEvaluator(thrower as never).evaluate('thrower', ctx);
    expect(result.basisPoints).toBe(0);
    expect(result.inputs).toMatchObject({ error: 'provider_threw' });
  });
});
