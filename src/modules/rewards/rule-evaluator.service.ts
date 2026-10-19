import { Injectable, Logger } from '@nestjs/common';
import { TransactionManager } from '@/database/transaction/transaction.manager';
import { RewardAwardRepository } from '@/database/repositories/reward-award.repository';
import type { RewardRuleRow } from '@/database/repositories/reward-rule.repository';
import { RewardRuleRepository } from '@/database/repositories/reward-rule.repository';
import { RewardProgramRepository } from '@/database/repositories/reward-program.repository';
import { RewardBenefitConfigSchema } from '@/shared/contracts/rewards/reward.contract';
import {
  RewardAwardMode,
  RewardAwardStatus,
  RewardCapScope,
  type RewardTriggerKind,
} from '@/shared/enums';
import { BenefitDispatcher } from './benefit-dispatcher.service';
import { ConditionRegistry } from './conditions/condition.registry';
import { FactorEvaluator, scaleByFactor } from './factor.provider';
import { derivePeriodKey } from './period-key.util';

/**
 * A customer did something. This decides whether it earns anything.
 *
 * The caller is a projector or a worker — never an HTTP request — so there is
 * no ambient actor, and nothing here writes to audit_logs. The ledger's
 * provenance (award, rule, rule_version) is the system-caused trail; audit_logs
 * is for the humans who change the rules.
 */
export interface RewardTriggerEvent {
  readonly enterpriseId: number;
  readonly customerId: number;
  readonly triggerKind: RewardTriggerKind;
  /** `message` or `post` — the row that caused this. */
  readonly sourceRefKind: string;
  readonly sourceRefId: number;
  readonly channelId: number | null;
  /** WHEN THEY ACTED. Every gate is judged against this, never now(). */
  readonly occurredAtUtc: Date;
  readonly content: string | null;
  readonly customerFirstSeenAt: Date | null;
}

const MS_PER_HOUR = 60 * 60 * 1000;

@Injectable()
export class RuleEvaluatorService {
  private readonly logger = new Logger(RuleEvaluatorService.name);

  constructor(
    private readonly rules: RewardRuleRepository,
    private readonly programs: RewardProgramRepository,
    private readonly awards: RewardAwardRepository,
    private readonly conditions: ConditionRegistry,
    private readonly factors: FactorEvaluator,
    private readonly dispatcher: BenefitDispatcher,
    private readonly tx: TransactionManager,
  ) {}

  /**
   * Evaluates every rule that could match, in priority order.
   *
   * SEVERAL RULES MAY GRANT FOR ONE EVENT, and that is correct: a base comment
   * rule and a happy-hour bonus both firing on one 4pm Tuesday comment is the
   * intended behaviour, and caps are per rule so each keeps its own slot.
   *
   * Each rule is its own transaction. One rule failing must not roll back a
   * sibling that already granted — they are independent decisions that happen
   * to share a trigger.
   */
  async onTriggerEvent(event: RewardTriggerEvent): Promise<void> {
    const candidates = await this.rules.findMatchingRules({
      enterpriseId: event.enterpriseId,
      triggerKind: event.triggerKind,
      occurredAt: event.occurredAtUtc,
    });

    for (const rule of candidates) {
      try {
        await this.tx.runInTransaction(() => this.evaluateRule(rule, event));
      } catch (error) {
        /*
         * One rule's failure is contained. Logged with enough to find it and
         * NOT rethrown: the caller is a projector, and failing the whole
         * projection because a reward rule misbehaved would hold up the
         * customer's message appearing in the inbox.
         */
        this.logger.error(
          `reward rule ${rule.id} v${rule.version} failed for ` +
            `${event.sourceRefKind}:${event.sourceRefId}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async evaluateRule(rule: RewardRuleRow, event: RewardTriggerEvent): Promise<void> {
    const program = await this.programs.findById(event.enterpriseId, rule.programId);
    if (!program) return;

    const conditions = await this.rules.loadConditions(event.enterpriseId, rule.id, rule.version);

    /*
     * GATE 4. Gates 1-3 (the program switch, the campaign dates, the rule's own
     * active flag) were SQL in findMatchingRules; this one is TypeScript
     * because a condition is a pure function over an already-loaded event.
     *
     * Checked BEFORE the award row exists: an event that never qualified is not
     * worth a row, where one that qualified and then hit a cap is.
     */
    const outcome = this.conditions.evaluate(conditions, {
      enterpriseId: event.enterpriseId,
      customerId: event.customerId,
      occurredAtUtc: event.occurredAtUtc,
      timezone: program.timezone,
      content: event.content,
      customerFirstSeenAt: event.customerFirstSeenAt,
    });

    const holdUntil =
      rule.holdHours > 0
        ? new Date(event.occurredAtUtc.getTime() + rule.holdHours * MS_PER_HOUR)
        : null;

    const award = await this.awards.createIfAbsent({
      enterpriseId: event.enterpriseId,
      programId: rule.programId,
      ruleId: rule.id,
      ruleVersion: rule.version,
      customerId: event.customerId,
      channelId: event.channelId,
      sourceRefKind: event.sourceRefKind,
      sourceRefId: event.sourceRefId,
      status: outcome.passed ? RewardAwardStatus.Held : RewardAwardStatus.SkippedCondition,
      heldUntil: outcome.passed ? holdUntil : null,
      occurredAtUtc: event.occurredAtUtc,
    });

    /*
     * Null means this exact event already produced an award for this rule — a
     * redelivered webhook, a replayed backfill, a retried job. Under
     * at-least-once delivery that is the NORMAL case, not an error.
     */
    if (!award) return;

    if (!outcome.passed) {
      await this.awards.markSkipped({
        enterpriseId: event.enterpriseId,
        awardId: award.id,
        status: RewardAwardStatus.SkippedCondition,
        /*
         * NAMES THE FAILING CONDITION. Folding the weekly window into the
         * condition list would otherwise have traded a precise
         * `outside_weekly_window` for a useless "a condition failed".
         */
        reasonCode: `condition_failed:${outcome.failedKind}`,
        periodKey: null,
      });
      return;
    }

    const periodKey = derivePeriodKey(event.occurredAtUtc, program.timezone, rule.capScope);

    if (rule.capScope !== RewardCapScope.None && periodKey) {
      const claimed = await this.awards.claimCapSlot({
        enterpriseId: event.enterpriseId,
        programId: rule.programId,
        ruleId: rule.id,
        customerId: event.customerId,
        periodKey,
        cap: rule.capCount,
      });
      if (!claimed) {
        await this.awards.markSkipped({
          enterpriseId: event.enterpriseId,
          awardId: award.id,
          status: RewardAwardStatus.SkippedCap,
          reasonCode: 'cap_consumed',
          periodKey,
        });
        return;
      }
    }

    const benefits = await this.rules.loadBenefits(event.enterpriseId, rule.id, rule.version);
    const budgetCost = benefits.reduce((sum, b) => sum + b.budgetCostMinor, 0);

    const funded = await this.awards.claimBudget({
      enterpriseId: event.enterpriseId,
      programId: rule.programId,
      costMinor: budgetCost,
    });
    if (!funded) {
      await this.releaseCap(event, rule, periodKey);
      await this.awards.markSkipped({
        enterpriseId: event.enterpriseId,
        awardId: award.id,
        status: RewardAwardStatus.SkippedBudget,
        reasonCode: 'budget_exhausted',
        periodKey,
      });
      return;
    }

    /*
     * A HELD award stops here with its cap and budget already claimed.
     *
     * Claiming at event time rather than at grant time is deliberate: it fails
     * fast, so a customer who is already capped is told by the absence of a
     * held award rather than by a grant that silently never happens a day
     * later. The cost is that a zero factor must hand the slot back (below).
     */
    if (holdUntil) return;

    await this.grant({
      enterpriseId: event.enterpriseId,
      awardId: award.id,
      customerId: event.customerId,
      rule,
      programTimezone: program.timezone,
      defaultCurrencyCode: program.defaultCurrencyCode,
      periodKey,
      occurredAtUtc: event.occurredAtUtc,
      benefits,
      budgetCost,
    });
  }

  /**
   * Runs the factor and applies the benefits. All of them, or none.
   *
   * Talon.One's default and the right one: if one benefit cannot be applied,
   * none of that rule's benefits are. A customer told they earned points AND a
   * coffee, who receives only the points, is a worse outcome than receiving
   * nothing and being told why.
   *
   * Atomicity costs nothing here because repositories resolve the ambient
   * transaction per call — no saga, no orchestrator, no engine.
   */
  async grant(input: {
    enterpriseId: number;
    awardId: number;
    customerId: number;
    rule: RewardRuleRow;
    programTimezone: string;
    defaultCurrencyCode: string | null;
    periodKey: string | null;
    occurredAtUtc: Date;
    benefits: readonly {
      benefitIndex: number;
      benefitKind: string;
      awardMode: RewardAwardMode;
      awardCap: number | null;
      budgetCostMinor: number;
      config: Record<string, unknown>;
    }[];
    budgetCost: number;
  }): Promise<void> {
    const needsFactor = input.benefits.some((b) => b.awardMode === RewardAwardMode.UpTo);

    const factor = needsFactor
      ? await this.factors.evaluate(input.rule.factorProviderCode, {
          enterpriseId: input.enterpriseId,
          customerId: input.customerId,
          ruleId: input.rule.id,
          occurredAtUtc: input.occurredAtUtc,
        })
      : { basisPoints: null, inputs: {} as Record<string, unknown> };

    /*
     * A ZERO FACTOR DOES NOT CONSUME THE CAP SLOT.
     *
     * The customer did not earn, so burning their once-a-week slot on a
     * benefit worth nothing would be the wrong outcome. The budget comes back
     * too. Unreachable with `constant_one`, which is exactly why it is tested
     * now rather than when a real provider first returns zero in production.
     */
    if (needsFactor && factor.basisPoints === 0) {
      await this.awards.releaseBudget({
        enterpriseId: input.enterpriseId,
        programId: input.rule.programId,
        costMinor: input.budgetCost,
      });
      if (input.periodKey) {
        await this.awards.releaseCapSlot({
          enterpriseId: input.enterpriseId,
          ruleId: input.rule.id,
          customerId: input.customerId,
          periodKey: input.periodKey,
        });
      }
      await this.awards.markSkipped({
        enterpriseId: input.enterpriseId,
        awardId: input.awardId,
        status: RewardAwardStatus.SkippedZeroFactor,
        reasonCode: 'factor_zero',
        periodKey: input.periodKey,
      });
      return;
    }

    for (const stored of input.benefits) {
      /*
       * WRITE-TIME VALIDATION HAPPENS ON THE WAY IN; this is the read-time
       * layer. A payload written before a schema change refuses loudly here
       * rather than arriving with a property the type insists is present.
       */
      const parsed = RewardBenefitConfigSchema.safeParse({
        benefitKind: stored.benefitKind,
        config: this.resolveConfig(stored, factor.basisPoints, input.defaultCurrencyCode),
      });
      if (!parsed.success) {
        throw new Error(
          `benefit ${stored.benefitKind} on rule ${input.rule.id} v${input.rule.version} ` +
            `does not match its schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        );
      }

      await this.dispatcher.apply(parsed.data, {
        enterpriseId: input.enterpriseId,
        customerId: input.customerId,
        awardId: input.awardId,
        ruleId: input.rule.id,
        ruleVersion: input.rule.version,
        occurredAtUtc: input.occurredAtUtc,
        benefitIndex: stored.benefitIndex,
        defaultCurrencyCode: input.defaultCurrencyCode,
      });
    }

    await this.awards.markGranted({
      enterpriseId: input.enterpriseId,
      awardId: input.awardId,
      factorBasisPoints: factor.basisPoints,
      factorProviderCode: needsFactor ? input.rule.factorProviderCode : null,
      factorInputs: factor.inputs,
      periodKey: input.periodKey,
    });
  }

  /**
   * Applies the factor to a scalable benefit's amount.
   *
   * Only `up_to` benefits are touched. A `fixed` one is a stated promise and a
   * factor has no business shaving it — and a discrete kind refuses `up_to` at
   * write time, so there is no path here that produces six tenths of a coffee.
   */
  private resolveConfig(
    stored: {
      benefitKind: string;
      awardMode: RewardAwardMode;
      awardCap: number | null;
      config: Record<string, unknown>;
    },
    basisPoints: number | null,
    defaultCurrencyCode: string | null,
  ): Record<string, unknown> {
    const config = { ...stored.config };
    if (config.currencyCode === undefined && defaultCurrencyCode !== null) {
      config.currencyCode = defaultCurrencyCode;
    }
    if (
      stored.awardMode !== RewardAwardMode.UpTo ||
      basisPoints === null ||
      stored.awardCap === null
    ) {
      return config;
    }

    const scaled = scaleByFactor(stored.awardCap, basisPoints);
    if ('points' in config) return { ...config, points: scaled };
    if ('minorUnits' in config) return { ...config, minorUnits: scaled };
    return config;
  }

  private async releaseCap(
    event: RewardTriggerEvent,
    rule: RewardRuleRow,
    periodKey: string | null,
  ): Promise<void> {
    if (!periodKey || rule.capScope === RewardCapScope.None) return;
    await this.awards.releaseCapSlot({
      enterpriseId: event.enterpriseId,
      ruleId: rule.id,
      customerId: event.customerId,
      periodKey,
    });
  }
}
