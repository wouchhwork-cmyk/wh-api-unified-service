import type { EntityManager } from 'typeorm';
import type { RewardBenefitConfig } from '@/shared/contracts/rewards/reward.contract';
import type { RewardBenefitKind, Reversibility } from '@/shared/enums';

/**
 * The benefit contract — one handler per kind, paired with its compensator.
 *
 * THE UNION IS DERIVED FROM THE ZOD SCHEMA, not written twice. The schema is
 * the source of truth for the wire, the stored payload and the type, so there
 * is no second declaration to drift against. `Extract` narrows it per kind.
 */
export type RewardBenefit = RewardBenefitConfig;

/** One member of the union, narrowed by its discriminator. */
export type BenefitOf<K extends RewardBenefitKind> = Extract<RewardBenefit, { benefitKind: K }>;

/**
 * What a handler needs, and deliberately all it needs.
 *
 * `manager` is the ambient transaction. Every DB benefit in one award commits
 * or none does, and that costs no plumbing because repositories resolve the
 * ambient transaction per call — so a handler does not take, pass, or know
 * about an EntityManager beyond handing it back to a repository.
 */
export interface BenefitContext {
  readonly manager: EntityManager;
  readonly enterpriseId: number;
  readonly customerId: number;
  readonly awardId: number;
  readonly ruleId: number;
  readonly ruleVersion: number;
  /** Business time — when the customer acted, not when we are processing it. */
  readonly occurredAtUtc: Date;
  /** Per benefit, derived from the award. Unique by construction. */
  readonly idempotencyKey: string;
  /** The program's currency default, for benefits that omit one. */
  readonly defaultCurrencyCode: string | null;
}

/**
 * What the handler PRODUCED, stored on the award benefit row.
 *
 * The compensator reads this and reverses exactly it. It never recomputes from
 * the rule: a rule edit between apply and compensate would then produce a wrong
 * reversal, and `ruleVersion` does not cover a factor that read live
 * engagement data. Medusa captures the undo payload at apply time for this
 * reason; Vendure hands its compensator the same inputs as the applier and
 * makes it re-derive, which is the weaker design.
 */
export interface AppliedBenefit {
  /** Ledger entry ids, entitlement ids — whatever undoing this needs. */
  readonly compensation: Record<string, unknown>;
  /** The resolved payload after the factor, for the award benefit row. */
  readonly payload: Record<string, unknown>;
}

interface BenefitHandlerBase<K extends RewardBenefitKind> {
  readonly kind: K;
  /**
   * Whether the factor may scale this benefit.
   *
   * `grant_points` is continuous — 0.6 x 20 = 12 means something. A free coffee
   * is discrete, and an `up_to` on a discrete kind once produced six tenths of
   * a coffee. The service refuses `up_to` on a handler that says false.
   */
  readonly scalable: boolean;
  apply(benefit: BenefitOf<K>, ctx: BenefitContext): Promise<AppliedBenefit>;
}

/** Has a compensator, and the type makes it REQUIRED rather than hoped for. */
export type CompensableBenefitHandler<K extends RewardBenefitKind> = BenefitHandlerBase<K> & {
  readonly reversibility: Reversibility.Compensable;
  /**
   * Idempotent: re-running with the same applied row is a success no-op.
   *
   * Note the two rules this sits inside. Re-submitting the SAME compensation is
   * a no-op, because the idempotency index swallows it. A DIFFERENT
   * compensation against an already-reversed entry is an ERROR, because the
   * one-reversal-per-entry index refuses it — swallowing that as a duplicate
   * would hide a double reversal.
   */
  compensate(applied: AppliedBenefit, ctx: BenefitContext): Promise<void>;
};

/**
 * Cannot be undone, and must say WHY in code.
 *
 * Two thirds of a mature loyalty engine is irreversible — Talon.One ships 42
 * effect types and 8 rollbacks. `compensate?: never` means a Pivot cannot be
 * half-written: you cannot quietly add a compensator to it and leave the
 * reversibility flag saying otherwise.
 */
export type PivotBenefitHandler<K extends RewardBenefitKind> = BenefitHandlerBase<K> & {
  readonly reversibility: Reversibility.Pivot;
  readonly irreversibleBecause: string;
  compensate?: never;
};

/**
 * A handler is one or the other, never both and never neither.
 *
 * A class cannot `implements` a union, so a handler declares the BRANCH it is —
 * which is the point: picking `CompensableBenefitHandler` and omitting
 * `compensate` fails in the handler's own file, not somewhere downstream.
 */
export type BenefitHandler<K extends RewardBenefitKind> =
  | CompensableBenefitHandler<K>
  | PivotBenefitHandler<K>;

/**
 * THE COMPLETENESS CHECK.
 *
 * A mapped type over the enum, so omitting a kind is TS1360 — which names the
 * missing member. Filing one under the wrong key is TS2322, which says which.
 * Neither is a lint rule or a convention; both are the build failing.
 *
 * This is not an abstraction. It is a table with a check, and it is the reason
 * adding a benefit kind is four files of which the compiler demands three.
 */
export type BenefitHandlerMap = {
  readonly [K in RewardBenefitKind]: BenefitHandler<K>;
};
