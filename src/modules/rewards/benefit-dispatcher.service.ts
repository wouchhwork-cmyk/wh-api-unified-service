import { Injectable, Logger } from '@nestjs/common';
import { RewardAwardRepository } from '@/database/repositories/reward-award.repository';
import { RewardBenefitKind, Reversibility } from '@/shared/enums';
import { BenefitRegistry } from './benefits/benefit.registry';
import type { AppliedBenefit, BenefitContext, RewardBenefit } from './benefits/benefit.types';

export interface DispatchContext {
  readonly enterpriseId: number;
  readonly customerId: number;
  readonly awardId: number;
  readonly ruleId: number;
  readonly ruleVersion: number;
  readonly occurredAtUtc: Date;
  readonly benefitIndex: number;
  readonly defaultCurrencyCode: string | null;
}

/**
 * Applies benefits, and records what each one did so it can be undone.
 *
 * Runs inside the caller's transaction. Every database benefit in one award
 * commits or none does, and that costs no plumbing: repositories resolve the
 * ambient transaction per call, so there is no saga, no orchestrator and no
 * workflow engine here.
 */
@Injectable()
export class BenefitDispatcher {
  private readonly logger = new Logger(BenefitDispatcher.name);

  constructor(
    private readonly registry: BenefitRegistry,
    private readonly awards: RewardAwardRepository,
  ) {}

  /**
   * One benefit, applied and recorded.
   *
   * Generic over the discriminant: `registry.get(benefit.benefitKind)` returns
   * the union of handlers, and calling `.apply(benefit)` on that intersects
   * every parameter type down to `never`. The generic keeps the handler and
   * the payload provably the same kind, with no cast.
   */
  async apply<K extends RewardBenefitKind>(
    benefit: Extract<RewardBenefit, { benefitKind: K }>,
    ctx: DispatchContext,
  ): Promise<void> {
    const handler = this.registry.get(benefit.benefitKind);

    /*
     * THE IDEMPOTENCY KEY IS DERIVED, never random.
     *
     * (award, benefit index) is unique by construction, so a retry of the same
     * dispatch produces the same key and the ledger's unique index refuses the
     * second write. A fresh UUID per attempt would make every retry a new
     * entry, which is the bug idempotency keys exist to prevent.
     */
    const benefitCtx: BenefitContext = {
      enterpriseId: ctx.enterpriseId,
      customerId: ctx.customerId,
      awardId: ctx.awardId,
      ruleId: ctx.ruleId,
      ruleVersion: ctx.ruleVersion,
      occurredAtUtc: ctx.occurredAtUtc,
      idempotencyKey: `award:${ctx.awardId}:benefit:${ctx.benefitIndex}`,
      defaultCurrencyCode: ctx.defaultCurrencyCode,
    };

    const applied = await handler.apply(benefit, benefitCtx);

    await this.awards.recordBenefit({
      enterpriseId: ctx.enterpriseId,
      awardId: ctx.awardId,
      benefitIndex: ctx.benefitIndex,
      benefitKind: benefit.benefitKind,
      payload: applied.payload,
      /*
       * WHAT THE HANDLER PRODUCED, stored so the compensator reverses exactly
       * that. A compensator that re-derives from the rule produces a wrong
       * reversal the moment the rule is edited between apply and compensate —
       * and rule_version does not cover a factor that read live data.
       */
      compensation: applied.compensation,
      idempotencyKey: benefitCtx.idempotencyKey,
    });
  }

  /**
   * Undoes everything an award did, newest benefit first.
   *
   * Reverse order because benefits can depend on one another within an award —
   * a conversion that consumed points granted by an earlier benefit must be
   * unwound before those points are taken back, or the burn has nothing to
   * reverse against.
   *
   * A PIVOT IS SKIPPED, LOUDLY. Two thirds of a mature loyalty engine is
   * irreversible, and pretending otherwise would be worse than recording that
   * this part of the award stands.
   */
  async compensateAward(input: {
    enterpriseId: number;
    awardId: number;
    customerId: number;
    ruleId: number;
    ruleVersion: number;
    occurredAtUtc: Date;
  }): Promise<void> {
    const applied = await this.awards.listAppliedBenefits(input.enterpriseId, input.awardId);

    for (const row of [...applied].reverse()) {
      const handler = this.registry.tryGet(row.benefitKind);

      /*
       * FAIL CLOSED on a kind this build no longer has.
       *
       * Everything else in this module refuses rather than guesses, and this
       * path is the worst place to throw: it would abort mid-compensation,
       * after earlier benefits in the same award have already been reversed.
       * Leaving the row uncompensated and saying so is recoverable; a
       * half-reversed award is not.
       */
      if (handler === undefined) {
        this.logger.error(
          `award ${input.awardId} has benefit kind ${row.benefitKind}, which this build ` +
            'does not know how to compensate; it has been left applied',
        );
        continue;
      }

      if (handler.reversibility === Reversibility.Pivot) {
        this.logger.warn(
          `award ${input.awardId} benefit ${row.benefitKind} is not reversible: ` +
            handler.irreversibleBecause,
        );
        continue;
      }

      const appliedBenefit: AppliedBenefit = {
        payload: row.payload,
        compensation: row.compensation,
      };

      await handler.compensate(appliedBenefit, {
        enterpriseId: input.enterpriseId,
        customerId: input.customerId,
        awardId: input.awardId,
        ruleId: input.ruleId,
        ruleVersion: input.ruleVersion,
        occurredAtUtc: input.occurredAtUtc,
        idempotencyKey: `award:${input.awardId}:benefit:${row.benefitIndex}`,
        defaultCurrencyCode: null,
      });

      await this.awards.markBenefitCompensated(input.enterpriseId, row.id);
    }
  }
}
