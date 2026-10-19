import { Injectable } from '@nestjs/common';
import { CONSTANT_ONE_FACTOR_PROVIDER, FACTOR_BASIS_POINTS_MAX } from '@/shared/enums';

export interface FactorContext {
  readonly enterpriseId: number;
  readonly customerId: number;
  readonly ruleId: number;
  readonly occurredAtUtc: Date;
}

export interface FactorResult {
  /** 0..10000. Clamped at the boundary, never inside a provider. */
  readonly basisPoints: number;
  /** WHAT THE PROVIDER READ. Without it, "why 0.7?" is unanswerable later. */
  readonly inputs: Record<string, unknown>;
}

export interface FactorProvider {
  readonly code: string;
  /** Returns [0, 1]. The caller clamps. */
  factor(ctx: FactorContext): Promise<number>;
}

/**
 * V1. Returns 1.0, so an `up_to` benefit pays its full cap.
 *
 * THIS IS A SEAM, NOT A PLACEHOLDER. The real engine — whatever it ends up
 * measuring — lands behind this interface and nothing above it changes. It is
 * recorded as backlog §8.1 with the product questions that block it.
 *
 * Why a factor rather than a formula over platform signals: insights and
 * business_discovery both refuse with Graph #10, so a story somebody else
 * posted has no readable metric at all. A formula would have excluded
 * story_mention — the headline use case — from variable awards entirely.
 */
@Injectable()
export class ConstantOneFactorProvider implements FactorProvider {
  readonly code = CONSTANT_ONE_FACTOR_PROVIDER;

  factor(): Promise<number> {
    return Promise.resolve(1);
  }
}

/**
 * Runs a provider and makes its answer safe.
 *
 * THE CLAMP IS HERE, at the boundary, not inside the provider — the provider is
 * the thing most likely to change, and one returning 1.5 must not pay 30
 * against a cap of 20. A provider that throws is treated as zero rather than
 * failing the award, because a scoring engine falling over should not take the
 * grant path down with it; the award records `skipped_zero_factor` and the
 * customer keeps their cap slot.
 */
@Injectable()
export class FactorEvaluator {
  constructor(private readonly constantOne: ConstantOneFactorProvider) {}

  async evaluate(providerCode: string, ctx: FactorContext): Promise<FactorResult> {
    const provider = this.resolve(providerCode);
    if (!provider) {
      return { basisPoints: 0, inputs: { error: 'unknown_provider', providerCode } };
    }

    try {
      const raw = await provider.factor(ctx);
      if (!Number.isFinite(raw)) {
        return { basisPoints: 0, inputs: { error: 'non_finite_factor' } };
      }
      const clamped = Math.min(Math.max(raw, 0), 1);
      return {
        basisPoints: Math.round(clamped * FACTOR_BASIS_POINTS_MAX),
        inputs: { provider: provider.code, raw },
      };
    } catch (error) {
      return {
        basisPoints: 0,
        inputs: { error: 'provider_threw', message: (error as Error).message },
      };
    }
  }

  /** Fails closed: an unknown provider scores zero rather than defaulting to full. */
  private resolve(code: string): FactorProvider | null {
    return code === this.constantOne.code ? this.constantOne : null;
  }
}

/**
 * cap x factor, in integer arithmetic, rounded half up.
 *
 * Basis points rather than a float because this is a value calculation and a
 * float has no place in one. Round half up rather than floor so a factor just
 * under a whole number does not quietly shortchange the customer.
 */
export function scaleByFactor(cap: number, basisPoints: number): number {
  return Math.floor((cap * basisPoints + FACTOR_BASIS_POINTS_MAX / 2) / FACTOR_BASIS_POINTS_MAX);
}
