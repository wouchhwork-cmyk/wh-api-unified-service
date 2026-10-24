import { Injectable, Logger } from '@nestjs/common';
import { TransactionManager } from '@/database/transaction/transaction.manager';
import { RewardAwardRepository } from '@/database/repositories/reward-award.repository';
import type { RewardRuleRow } from '@/database/repositories/reward-rule.repository';
import { RewardRuleRepository } from '@/database/repositories/reward-rule.repository';
import { RewardProgramRepository } from '@/database/repositories/reward-program.repository';
import {
  RewardBenefitConfigSchema,
  RewardTriggerConfigSchema,
} from '@/shared/contracts/rewards/reward.contract';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { RewardWalletRepository } from '@/database/repositories/reward-wallet.repository';
import {
  RewardAwardMode,
  RewardAwardStatus,
  RewardBenefitKind,
  RewardCapScope,
  RewardConditionKind,
  RewardTriggerKind,
  RewardWalletKind,
} from '@/shared/enums';
import { BenefitDispatcher } from './benefit-dispatcher.service';

import { ConditionRegistry } from './conditions/condition.registry';
import { FactorEvaluator, scaleByFactor } from './factor.provider';
import { derivePeriodKey } from './period-key.util';
import { matchesTriggerConfig } from './trigger-match.util';

/** The benefit kinds whose payload carries a currency. */
const CURRENCY_BEARING_KINDS: ReadonlySet<RewardBenefitKind> = new Set([
  RewardBenefitKind.GrantCurrency,
  RewardBenefitKind.ConvertValue,
]);

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
  /**
   * The points balance AFTER whatever caused this event.
   *
   * Only the post-grant producer knows one; every other path passes null and a
   * threshold rule then refuses. Required rather than optional so a new
   * producer has to decide rather than inherit a default.
   */
  readonly pointsBalance: number | null;
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
    private readonly customers: CustomerRepository,
    private readonly wallets: RewardWalletRepository,
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
      /* Judged before the transaction opens: a rule scoped to another channel
       * should cost one comparison, not a connection. */
      if (!this.matchesTriggerConfig(rule, event)) continue;

      let creditedAwardId: number | null = null;
      try {
        creditedAwardId = await this.tx.runInTransaction(() => this.evaluateRule(rule, event));
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
        continue;
      }

      if (creditedAwardId === null) continue;

      /*
       * AFTER THE COMMIT, never inside it. Nesting JOINS the ambient
       * transaction without a savepoint, so a threshold rule that threw would
       * poison the grant that earned the points — and the catch above would
       * swallow it, leaving this method believing the grant committed.
       */
      try {
        await this.offerBalanceThresholds({
          enterpriseId: event.enterpriseId,
          customerId: event.customerId,
          occurredAtUtc: event.occurredAtUtc,
          awardId: creditedAwardId,
          grantingTriggerKind: rule.triggerKind,
        });
      } catch (error) {
        this.logger.error(
          `threshold offer after award ${creditedAwardId} failed: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Gate 3, second half: the kind was matched in SQL, the config here.
   *
   * This method is the READ-TIME PARSE; the comparison itself is a pure
   * function in trigger-match.util. A config written before a schema change
   * refuses loudly here rather than matching by accident.
   */
  private matchesTriggerConfig(rule: RewardRuleRow, event: RewardTriggerEvent): boolean {
    const parsed = RewardTriggerConfigSchema.safeParse(rule.triggerConfig);
    if (!parsed.success) {
      this.logger.error(
        `rule ${rule.id} v${rule.version} has an unreadable trigger config and matches nothing: ` +
          `${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
      return false;
    }

    return matchesTriggerConfig(parsed.data, {
      channelId: event.channelId,
      pointsBalance: event.pointsBalance,
    });
  }

  /**
   * Points were credited. Offer the new balance to the threshold rules.
   *
   * THIS IS THE PRODUCER for `points_balance_reached`. Without one a conversion
   * rule could be written, switched on, listed in the portal — and never fire.
   * That is the round-5 defect, one trigger down.
   *
   * The source ref is the AWARD that credited, not the message behind it: both
   * the immediate and the deferred grant path hold an award id, and the
   * exactly-once index then does the deduplication for free — one threshold
   * award per crediting award per rule however often the work is retried,
   * while the next crossing arrives under its own award and is judged afresh.
   */
  async offerBalanceThresholds(input: {
    enterpriseId: number;
    customerId: number;
    occurredAtUtc: Date;
    awardId: number;
    grantingTriggerKind: RewardTriggerKind;
  }): Promise<void> {
    /*
     * A threshold rule must never fire another. Nothing today grants points
     * from a balance crossing, but the day somebody writes that rule it is an
     * unbounded loop granting real value, and the guard costs a comparison.
     */
    if (input.grantingTriggerKind === RewardTriggerKind.PointsBalanceReached) return;

    /*
     * Asked before the wallet is read, and asked again inside onTriggerEvent.
     * Two indexed queries for the businesses that configured a threshold rule;
     * no wallet read at all for the many that did not, on a path that runs
     * after every single credit.
     */
    const thresholdRules = await this.rules.findMatchingRules({
      enterpriseId: input.enterpriseId,
      triggerKind: RewardTriggerKind.PointsBalanceReached,
      occurredAt: input.occurredAtUtc,
    });
    if (thresholdRules.length === 0) return;

    const wallet = await this.wallets.findCustomerWallet(
      input.enterpriseId,
      input.customerId,
      RewardWalletKind.Points,
      null,
    );
    if (!wallet || wallet.balance <= 0) return;

    await this.onTriggerEvent({
      enterpriseId: input.enterpriseId,
      customerId: input.customerId,
      triggerKind: RewardTriggerKind.PointsBalanceReached,
      sourceRefKind: 'award',
      sourceRefId: input.awardId,
      /* A balance crossing belongs to no channel, which is why the contract
       * refuses `channelIds` on this trigger. */
      channelId: null,
      occurredAtUtc: input.occurredAtUtc,
      content: null,
      /* Fetched lazily by the tenure condition if a rule asks for it. */
      customerFirstSeenAt: null,
      pointsBalance: wallet.balance,
    });
  }

  /**
   * One rule against one event.
   *
   * Returns the award id when this rule CREDITED POINTS, so the caller can
   * offer the new balance to the threshold rules once the transaction has
   * committed. Null covers every other outcome — refused, capped, unfunded,
   * held, deduplicated, or granted without touching a points balance.
   */
  private async evaluateRule(
    rule: RewardRuleRow,
    event: RewardTriggerEvent,
  ): Promise<number | null> {
    const program = await this.programs.findById(event.enterpriseId, rule.programId);
    if (!program) return null;

    const conditions = await this.rules.loadConditions(event.enterpriseId, rule.id, rule.version);

    /*
     * The tenure condition needs to know when we first saw this customer, and
     * nothing upstream carries it — a projector would have to load a customer
     * row for every message to serve a condition most rules do not use.
     *
     * So it is fetched HERE, lazily, only when a rule actually asks. Left null
     * the condition fails closed, which is the safe direction but makes the
     * condition useless: a rule carrying one would never grant, silently.
     */
    const needsTenure = conditions.some(
      (c) => c.conditionKind === RewardConditionKind.CustomerTenure,
    );
    const customerFirstSeenAt =
      event.customerFirstSeenAt ??
      (needsTenure
        ? await this.customers.findFirstSeenAt(event.enterpriseId, event.customerId)
        : null);

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
      customerFirstSeenAt,
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
    if (!award) return null;

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
      return null;
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
        return null;
      }
    }

    const benefits = await this.rules.loadBenefits(event.enterpriseId, rule.id, rule.version);

    /*
     * A HELD award stops here with its cap already claimed.
     *
     * Claiming at event time rather than at grant time is deliberate: it fails
     * fast, so a customer who is already capped is told by the absence of a
     * held award rather than by a grant that silently never happens a day
     * later. The cost is that a zero factor must hand the slot back (below).
     *
     * It also credits nothing YET, so there is no balance to offer: the
     * deferred path makes that offer when it finally grants.
     */
    if (holdUntil) return null;

    const creditedPoints = await this.grant({
      enterpriseId: event.enterpriseId,
      awardId: award.id,
      customerId: event.customerId,
      rule,
      programTimezone: program.timezone,
      defaultCurrencyCode: program.defaultCurrencyCode,
      periodKey,
      occurredAtUtc: event.occurredAtUtc,
      benefits,
    });
    return creditedPoints ? award.id : null;
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
      config: Record<string, unknown>;
    }[];
    /** True when a points balance went UP, which is what a threshold watches. */
  }): Promise<boolean> {
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
     * benefit worth nothing would be the wrong outcome. Unreachable with
     * `constant_one`, which is exactly why it is tested now rather than when a
     * real provider first returns zero in production.
     */
    const worthless =
      needsFactor &&
      (factor.basisPoints === 0 ||
        input.benefits.some((b) => this.scalesToNothing(b, factor.basisPoints)));

    if (worthless) {
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
        reasonCode: factor.basisPoints === 0 ? 'factor_zero' : 'factor_scaled_to_zero',
        periodKey: input.periodKey,
      });
      return false;
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

    /*
     * `grant_points` is the only kind that RAISES a points balance — a
     * conversion spends them, so it can never cross a threshold upward.
     */
    return input.benefits.some(
      /* Cast because the kind arrives as database text, the same way
       * resolveConfig reads it below. */
      (b) => (b.benefitKind as RewardBenefitKind) === RewardBenefitKind.GrantPoints,
    );
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

    /*
     * The program's default currency fills in only for the kinds that TAKE a
     * currency.
     *
     * Injecting it everywhere put `currencyCode` into a points payload, and
     * the schemas are strictObject, so every points rule inside a program with
     * a default currency threw at grant time — which is the ordinary
     * configuration, not an exotic one.
     */
    if (
      config.currencyCode === undefined &&
      defaultCurrencyCode !== null &&
      CURRENCY_BEARING_KINDS.has(stored.benefitKind as RewardBenefitKind)
    ) {
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

  /**
   * Did the factor scale this benefit down to nothing?
   *
   * A cap of 1 with a factor of 0.4 rounds to zero, and the schemas require a
   * positive amount — so without this the award would THROW on a payload that
   * is simply not worth granting. It is the same situation as a zero factor
   * and takes the same path: nothing is awarded, and the cap slot is handed
   * back because the customer did not earn.
   */
  private scalesToNothing(
    stored: { awardMode: RewardAwardMode; awardCap: number | null },
    basisPoints: number | null,
  ): boolean {
    if (stored.awardMode !== RewardAwardMode.UpTo) return false;
    if (basisPoints === null || stored.awardCap === null) return false;
    return scaleByFactor(stored.awardCap, basisPoints) < 1;
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
