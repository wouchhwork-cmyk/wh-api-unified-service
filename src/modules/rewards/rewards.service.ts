import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { RewardAwardRepository } from '@/database/repositories/reward-award.repository';
import { RewardEntitlementRepository } from '@/database/repositories/reward-entitlement.repository';
import { RewardProgramRepository } from '@/database/repositories/reward-program.repository';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { RewardRuleRepository } from '@/database/repositories/reward-rule.repository';
import { RewardWalletRepository } from '@/database/repositories/reward-wallet.repository';
import { TransactionManager } from '@/database/transaction/transaction.manager';
import { AuditService } from '@/modules/audit/audit.service';
import { EntityVersionService } from '@/modules/audit/entity-version.service';
import { NOOP_FORWARD_PROVIDER } from '@/shared/contracts/rewards/reward.contract';
import type {
  AdjustRewardBalanceInput,
  CreateRewardProgramInput,
  CreateRewardRuleInput,
  RewardBenefitInput,
  RewardConditionConfig,
  RewardDestination,
  UpdateRewardProgramInput,
} from '@/shared/contracts/rewards/reward.contract';
import {
  ActorKind,
  AuditAction,
  CURRENCY_BEARING_BENEFITS,
  RewardCapScope,
  RewardConditionKind,
  RewardReversalPolicy,
  RewardTriggerKind,
  AuditEntityType,
  CONSTANT_ONE_FACTOR_PROVIDER,
  RewardAwardMode,
  RewardAwardStatus,
  RewardEntryKind,
  type RewardProgramStatus,
  RewardWalletKind,
} from '@/shared/enums';
import { RequestContext } from '@/shared/context';
import { AppException, ErrorCode } from '@/shared/errors';
import { BenefitRegistry } from './benefits/benefit.registry';

const DEFAULT_PAGE = 50;
/** A backstop on tenant-controlled lists, not a page size. */
const MAX_ROWS = 200;

/**
 * Everything a human does to a reward program.
 *
 * EVERY WRITE HERE IS AUDITED, because a rule decides who receives value and
 * changing one is a money decision. Awards are deliberately NOT audited — see
 * AuditEntityType.RewardProgram for why.
 */
@Injectable()
export class RewardsService {
  constructor(
    private readonly programs: RewardProgramRepository,
    private readonly rules: RewardRuleRepository,
    private readonly awards: RewardAwardRepository,
    private readonly wallets: RewardWalletRepository,
    private readonly entitlements: RewardEntitlementRepository,
    private readonly customers: CustomerRepository,
    private readonly benefits: BenefitRegistry,
    private readonly audit: AuditService,
    private readonly enterprises: EnterpriseRepository,
    private readonly versions: EntityVersionService,
    private readonly tx: TransactionManager,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Programs                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * What goes into a program's version history.
   *
   * STATED, NOT SERIALISED. `forwardConfig` is deliberately absent: it holds a
   * CREDENTIAL REFERENCE, and the history is append-only, so a secret written
   * there could never be taken back out. Listing the fields by hand is what
   * keeps that from happening the day somebody adds a column.
   */
  private static snapshotOf(
    program: {
      name: string;
      displayName: string | null;
      status: string;
      startsAt: Date | null;
      endsAt: Date | null;
      forwardProviderCode: string | null;
    },
    /*
     * THE SHAPE OF THE RULE SET, not its contents.
     *
     * The rules themselves are versioned rows: an award carries `ruleId` and
     * `ruleVersion`, so exactly what decided it is already recoverable to the
     * benefit. Copying all of that in here would be a second authority that
     * could disagree with the first. What the version history adds is what the
     * programme LOOKED LIKE — which triggers it ran on and how much it
     * awarded — so somebody reading it can see a programme change shape
     * without opening every rule.
     */
    rules?: { triggers: readonly string[]; benefitCount: number },
  ): Record<string, unknown> {
    return {
      name: program.name,
      displayName: program.displayName,
      status: program.status,
      startsAt: program.startsAt?.toISOString() ?? null,
      endsAt: program.endsAt?.toISOString() ?? null,
      forwardProviderCode: program.forwardProviderCode,
      ...(rules ? { triggers: [...rules.triggers], benefitCount: rules.benefitCount } : {}),
    };
  }

  /**
   * The destination choice, as the column stores it.
   *
   * NULL means the value stays in Wouchh. `'noop'` is the design's own name
   * for the provider that records intent and moves nothing — which is what
   * "external" can honestly mean until the forwarding pipeline in
   * `docs/reward-programs-design.md` §13 is built.
   */
  private static providerFor(destination: RewardDestination): string | null {
    return destination === 'external' ? NOOP_FORWARD_PROVIDER : null;
  }

  /**
   * Appends a version row AND mirrors its number onto the programme.
   *
   * Together, because the mirror exists to be read on the award path and a
   * mirror that lags what it mirrors would stamp awards with the wrong
   * version. `record` rethrows inside a transaction, so a failure here takes
   * the whole edit with it rather than leaving a version-less change.
   */
  private async recordProgramVersion(
    enterpriseId: number,
    program: {
      id: number;
      name: string;
      displayName: string | null;
      status: string;
      startsAt: Date | null;
      endsAt: Date | null;
      forwardProviderCode: string | null;
    },
    rules?: { triggers: readonly string[]; benefitCount: number },
  ): Promise<void> {
    const version = await this.versions.record({
      entityType: AuditEntityType.RewardProgram,
      entityId: program.id,
      enterpriseId,
      snapshot: RewardsService.snapshotOf(program, rules),
    });
    if (version !== null) {
      await this.programs.setVersion(enterpriseId, program.id, version);
    }
  }

  /**
   * ONE TRANSACTION over all three writes.
   *
   * This was three independent commits. A failure after the first left a
   * reward program with no version 1 — exactly the row the comment below says
   * must always exist — and a program whose history begins at its first edit
   * can never answer what it originally was.
   */
  async createProgram(enterpriseId: number, input: CreateRewardProgramInput) {
    /*
     * CHECKED BEFORE THE TRANSACTION OPENS, because both of these are reads
     * of the business and neither needs to be inside one. A programme whose
     * triggers need a calendar or a currency the business has not set is
     * refused with the code that names the remedy, exactly as a rule is.
     */
    if (input.triggers.length > 0) {
      const business = await this.enterprises.findById(enterpriseId);
      RewardsService.assertProgramCanRun(
        input,
        business?.timezone ?? null,
        business?.currencyCode ?? null,
      );
    }

    return this.tx.runInTransaction(async () => {
      const program = await this.programs.create({
        enterpriseId,
        name: input.name,
        displayName: input.displayName,
        /* The schedule's dates ARE the programme's dates. One concept, asked
         * once, rather than a programme window and a schedule window that can
         * disagree. */
        startsAt: input.schedule.startsAt,
        endsAt: input.schedule.endsAt,
        forwardProviderCode: RewardsService.providerFor(input.destination),
      });

      await this.audit.record({
        action: AuditAction.Created,
        entityType: AuditEntityType.RewardProgram,
        entityId: program.id,
        enterpriseId,
        /*
         * The shape, never a secret. forward_config holds a credential
         * REFERENCE, so it is excluded entirely — auditing that it changed is
         * right, auditing its value is not.
         */
        changes: {
          name: program.name,
          displayName: program.displayName,
          destination: input.destination,
        },
      });

      /*
       * VERSION 1 — the state the program began in.
       *
       * Without it the history would start at the first EDIT, and "what did
       * this look like originally" would be the one question it could not
       * answer.
       */
      await this.recordProgramVersion(enterpriseId, program, {
        triggers: input.triggers,
        benefitCount: input.benefits.length,
      });

      /*
       * ONE RULE PER TRIGGER, in the same transaction.
       *
       * The engine's shape is unchanged — a rule carries exactly one trigger
       * — and that is not what the person filling in the form is thinking
       * about. They are saying "reward DMs and story mentions", which is two
       * rules sharing everything else. Expanding here rather than making the
       * client write them keeps the two from drifting, and keeps a
       * half-created programme from existing at all.
       */
      const conditions = RewardsService.scheduleToConditions(input.schedule);
      for (const triggerKind of input.triggers) {
        await this.createRuleWithin(enterpriseId, program.id, {
          triggerKind,
          triggerConfig:
            triggerKind === RewardTriggerKind.PointsBalanceReached
              ? { minPointsBalance: input.minPointsBalance }
              : {},
          capScope: input.capScope,
          capCount: input.capCount,
          holdHours: input.holdHours,
          /* Always `none` while the switch is off the wire — see the note on
           * the contract. The engine path stays; nothing configures it. */
          reversalPolicy: RewardReversalPolicy.None,
          benefits: input.benefits,
          conditions,
        });
      }

      return program;
    });
  }

  /**
   * Editing a programme: the same form, the same body, one save.
   *
   * THE RULES ARE SUPERSEDED, NEVER EDITED. `reward_rules` is documented as
   * versioned and never edited in place, and it has to be: an award stores
   * `rule_id` + `rule_version`, so the row that decided a payment last March
   * must still say what it said last March. Editing one would silently rewrite
   * the justification for every award made under it.
   *
   * So an edit switches the old rules off and writes new ones beside them,
   * each chained to the rule it replaces through `supersedes_rule_id`. The old
   * rows stay readable, stop matching new events, and every existing award
   * still resolves to the exact configuration that produced it.
   *
   * TRIGGERS REMOVED simply keep their deactivated rule. Triggers ADDED get a
   * version 1 rule of their own. Triggers KEPT get the next version of theirs.
   *
   * ONE TRANSACTION over all of it, because a programme whose old rules were
   * switched off and whose new ones failed to write is a programme that has
   * silently stopped rewarding anybody.
   */
  async updateProgram(enterpriseId: number, refId: string, input: UpdateRewardProgramInput) {
    const existing = await this.programs.findByRefId(enterpriseId, refId);
    if (!existing) throw new AppException(ErrorCode.RewardProgramNotFound);

    /*
     * Read outside the transaction, exactly as the create path does: both are
     * reads of the business, and an edit that needs a calendar or a currency
     * the business has not set is refused with the code that names the remedy.
     */
    if (input.triggers.length > 0) {
      const business = await this.enterprises.findById(enterpriseId);
      RewardsService.assertProgramCanRun(
        input,
        business?.timezone ?? null,
        business?.currencyCode ?? null,
      );
    }

    return this.tx.runInTransaction(async () => {
      const outcome = await this.programs.updateDetails({
        enterpriseId,
        id: existing.id,
        name: input.name,
        displayName: input.displayName,
        startsAt: input.schedule.startsAt,
        endsAt: input.schedule.endsAt,
        forwardProviderCode: RewardsService.providerFor(input.destination),
      });
      /* Re-checked here rather than trusted from the read above: the status
       * can move between the two, and archiving is one-way. */
      if (outcome === 'missing') throw new AppException(ErrorCode.RewardProgramNotFound);
      if (outcome === 'archived') throw new AppException(ErrorCode.RewardProgramArchived);

      /*
       * EVERY ACTIVE RULE GOES OFF FIRST, and the statement says which they
       * were. Doing it in one UPDATE rather than per trigger means a rule for
       * a trigger that has just been REMOVED is switched off too — the case
       * that is easy to forget and leaves a programme still awarding for
       * something nobody asked for any more.
       */
      const retired = await this.rules.deactivateProgramRules(enterpriseId, existing.id);

      /* The newest version of each trigger's lineage, to chain to. */
      const previous = new Map<string, { id: number; version: number }>();
      for (const rule of retired) {
        const held = previous.get(rule.triggerKind);
        if (!held || rule.version > held.version) {
          previous.set(rule.triggerKind, { id: rule.id, version: rule.version });
        }
      }

      const conditions = RewardsService.scheduleToConditions(input.schedule);
      for (const triggerKind of input.triggers) {
        const prior = previous.get(triggerKind);
        await this.createRuleWithin(enterpriseId, existing.id, {
          triggerKind,
          triggerConfig:
            triggerKind === RewardTriggerKind.PointsBalanceReached
              ? { minPointsBalance: input.minPointsBalance }
              : {},
          capScope: input.capScope,
          capCount: input.capCount,
          holdHours: input.holdHours,
          reversalPolicy: RewardReversalPolicy.None,
          benefits: input.benefits,
          conditions,
          /* Chained to what it replaces, or starting a lineage of its own. */
          version: prior ? prior.version + 1 : 1,
          supersedesRuleId: prior ? prior.id : null,
        });
      }

      await this.audit.record({
        action: AuditAction.Updated,
        entityType: AuditEntityType.RewardProgram,
        entityId: existing.id,
        enterpriseId,
        /*
         * WHAT IT IS NOW, and what it cost to get there. `rulesRetired` is the
         * number of rules switched off, which is how somebody reading the
         * trail sees that an edit replaced a configuration rather than only
         * renaming it. forward_config is never recorded — it holds a
         * credential reference.
         */
        changes: {
          name: input.name,
          displayName: input.displayName,
          destination: input.destination,
          triggers: [...input.triggers],
          benefitCount: input.benefits.length,
          rulesRetired: retired.length,
        },
      });

      const updated = await this.programs.findById(enterpriseId, existing.id);
      if (!updated) throw new AppException(ErrorCode.RewardProgramNotFound);

      await this.recordProgramVersion(enterpriseId, updated, {
        triggers: input.triggers,
        benefitCount: input.benefits.length,
      });

      /* Read back AFTER the version is mirrored, so the caller is handed the
       * version number its edit actually produced rather than the one before. */
      return await this.programs.findById(enterpriseId, existing.id);
    });
  }

  listPrograms(
    enterpriseId: number,
    limit = DEFAULT_PAGE,
    status: RewardProgramStatus | null = null,
  ) {
    return this.programs.list(enterpriseId, limit, status);
  }

  /**
   * Switch a programme on, pause it, or archive it.
   *
   * ARCHIVING IS ONE-WAY. A programme is never deleted — the awards, the ledger
   * entries and the audit trail all point at it, and a business needs to be
   * able to answer "what was running last March". Archiving retires it instead:
   * the record stays, the rules stop matching, and it cannot be switched back
   * on. Reusing it would mean its old awards and its new ones share a
   * programme, and the dashboard could never separate them.
   */
  async setProgramStatus(enterpriseId: number, refId: string, status: RewardProgramStatus) {
    return this.tx.runInTransaction(async () => {
      const outcome = await this.programs.setStatus(enterpriseId, refId, status);
      if (outcome === 'missing') throw new AppException(ErrorCode.RewardProgramNotFound);
      if (outcome === 'archived') throw new AppException(ErrorCode.RewardProgramArchived);

      const program = await this.programs.findByRefId(enterpriseId, refId);

      await this.audit.record({
        action: AuditAction.Updated,
        entityType: AuditEntityType.RewardProgram,
        entityId: program?.id ?? null,
        enterpriseId,
        changes: { status },
      });

      /*
       * A STATUS CHANGE IS A NEW VERSION, not a footnote to the last one.
       *
       * Switching a program on is what makes its rules start awarding, so
       * "when did this become active" is a money question. The version row
       * carries the whole configuration at that moment, so the answer does not
       * depend on replaying every earlier diff.
       */
      if (program) {
        await this.recordProgramVersion(enterpriseId, program);
      }

      return program;
    });
  }

  /**
   * What this program has looked like, newest first.
   *
   * THE PROGRAM IS RESOLVED FIRST, and that is the tenant check. `refId` is
   * the only handle a client has, and looking it up scoped to the enterprise is
   * what makes a version history unreachable across tenants — the version table
   * is addressed by a NUMERIC id that never leaves the server.
   */
  async programHistory(enterpriseId: number, refId: string, limit: number) {
    const program = await this.programs.findByRefId(enterpriseId, refId);
    if (!program) throw new AppException(ErrorCode.RewardProgramNotFound);

    return this.versions.history(enterpriseId, AuditEntityType.RewardProgram, program.id, limit);
  }

  /**
   * The dashboard: what every program has actually done.
   *
   * THREE QUERIES TOTAL, whatever the program count — the list, the activity
   * grouped by program, and the value grouped by program. Fetching per program
   * made a fifty-program page issue a hundred and one.
   *
   * Entitlements are deliberately absent from the value figures. An issued
   * right is a promise, not a balance, and folding it into a money total would
   * overstate what a program has spent.
   */
  async programDashboard(enterpriseId: number) {
    const [programs, activity, value] = await Promise.all([
      this.programs.list(enterpriseId, DEFAULT_PAGE),
      this.awards.activityByProgram(enterpriseId),
      this.awards.valueByProgram(enterpriseId),
    ]);

    return programs.map((program) => {
      const rows = activity.filter((row) => row.programId === program.id);
      const granted = rows.find((row) => row.status === RewardAwardStatus.Granted);
      const held = rows.find((row) => row.status === RewardAwardStatus.Held);
      const reversed = rows.find((row) => row.status === RewardAwardStatus.Reversed);

      return {
        refId: program.refId,
        name: program.name,
        displayName: program.displayName,
        status: program.status,
        awardsGranted: granted?.awards ?? 0,
        awardsHeld: held?.awards ?? 0,
        awardsReversed: reversed?.awards ?? 0,
        /** Rewarded at least once. Counted on granted awards only. */
        customersRewarded: granted?.customers ?? 0,
        /*
         * Every status, including the refusals. A program granting 12 and
         * refusing 400 is working as configured, and that is a thing the
         * business needs to see rather than a thing to hide.
         */
        byStatus: rows.map((row) => ({ status: row.status, awards: row.awards })),
        /*
         * Net of reversals, never summed across currencies, and NEVER
         * summed across programs — `net` stays a string all the way to the
         * client for the reason the repository gives.
         */
        value: value
          .filter((row) => row.programId === program.id)
          .map((row) => ({
            walletKind: row.walletKind,
            currencyCode: row.currencyCode,
            net: row.net,
          })),
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Rules                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Writes a rule and the two child sets it owns, in one transaction.
   *
   * A rule whose benefits failed to insert would appear configured and award
   * nothing, which is worse than not existing.
   */
  async createRule(enterpriseId: number, input: CreateRewardRuleInput) {
    const program = await this.programs.findByRefId(enterpriseId, input.programRefId);
    if (!program) throw new AppException(ErrorCode.RewardProgramNotFound);

    this.assertBenefitsAreCoherent(input);
    RewardsService.assertMoneyHasACurrency(input, program.enterpriseCurrencyCode);
    RewardsService.assertCalendarRulesHaveATimezone(input, program.enterpriseTimezone);

    const rule = await this.tx.runInTransaction(() =>
      this.createRuleWithin(enterpriseId, program.id, {
        triggerKind: input.triggerKind,
        triggerConfig: input.triggerConfig,
        capScope: input.capScope,
        capCount: input.capCount,
        holdHours: input.holdHours,
        reversalPolicy: RewardReversalPolicy.None,
        priority: input.priority,
        benefits: input.benefits,
        conditions: input.conditions,
      }),
    );

    return rule;
  }

  /**
   * Writes ONE rule, with its benefits, conditions, audit row and version.
   *
   * MUST BE CALLED INSIDE A TRANSACTION, and both callers open one. It exists
   * because a programme created whole writes several of these and a rule added
   * on its own writes one, and two copies of "what a rule is" would disagree
   * the first time either gained a field.
   */
  private async createRuleWithin(
    enterpriseId: number,
    programId: number,
    input: {
      triggerKind: RewardTriggerKind;
      triggerConfig: Record<string, unknown>;
      capScope: RewardCapScope;
      capCount: number;
      holdHours: number;
      reversalPolicy: RewardReversalPolicy;
      priority?: number;
      benefits: readonly RewardBenefitInput[];
      conditions: readonly RewardConditionConfig[];
      /*
       * WHERE THIS RULE SITS IN ITS LINEAGE. A rule created fresh is version
       * 1 superseding nothing; one written by an edit is the next version of
       * the rule it replaces. Defaulted rather than required so the create
       * path, which only ever writes version 1, does not have to say so.
       */
      version?: number;
      supersedesRuleId?: number | null;
    },
  ) {
    {
      const created = await this.rules.insertRule({
        enterpriseId,
        programId,
        version: input.version ?? 1,
        supersedesRuleId: input.supersedesRuleId ?? null,
        triggerKind: input.triggerKind,
        triggerConfig: input.triggerConfig,
        factorProviderCode: CONSTANT_ONE_FACTOR_PROVIDER,
        capScope: input.capScope,
        capCount: input.capCount,
        holdHours: input.holdHours,
        reversalPolicy: input.reversalPolicy,
        priority: input.priority ?? 0,
      });

      await this.rules.insertBenefits(
        enterpriseId,
        created.id,
        created.version,
        input.benefits.map((b) => ({
          benefitKind: b.benefitKind,
          awardMode: b.awardMode,
          awardCap: b.awardCap,
          config: b.config as Record<string, unknown>,
        })),
      );

      await this.rules.insertConditions(
        enterpriseId,
        created.id,
        created.version,
        input.conditions.map((c) => ({
          conditionKind: c.conditionKind,
          config: c.config as Record<string, unknown>,
        })),
      );

      /*
       * INSIDE the transaction, with the rows they describe. A rule, its
       * benefits and its conditions are written here; an audit row or a
       * version written after the commit could survive a rule that did not.
       */
      await this.audit.record({
        action: AuditAction.Created,
        entityType: AuditEntityType.RewardRule,
        entityId: created.id,
        enterpriseId,
        changes: {
          triggerKind: created.triggerKind,
          version: created.version,
          benefitCount: input.benefits.length,
          conditionCount: input.conditions.length,
        },
      });

      /*
       * A RULE IS WHAT DECIDES WHO RECEIVES VALUE, so its history matters more
       * than the program's. "What was this rule awarding in March" has to be
       * answerable from one row, because an award made then was decided by the
       * rule as it stood then.
       */
      await this.versions.record({
        entityType: AuditEntityType.RewardRule,
        entityId: created.id,
        enterpriseId,
        snapshot: RewardsService.ruleSnapshotOf(created, input),
      });

      return created;
    }
  }

  /**
   * What goes into a rule's version history.
   *
   * STATED, NOT SERIALISED, for the reason `snapshotOf` gives: the history is
   * append-only, so a field added later must be a decision rather than an
   * accident. Benefits and conditions are included because they ARE the rule —
   * a version recording only the trigger would answer nothing about what was
   * awarded.
   */
  private static ruleSnapshotOf(
    rule: {
      triggerKind: string;
      version: number;
      capScope: string;
      capCount: number;
      holdHours: number;
      reversalPolicy: string;
      isActive: boolean;
    },
    input: {
      triggerConfig: Record<string, unknown>;
      benefits: readonly RewardBenefitInput[];
      conditions: readonly RewardConditionConfig[];
    },
  ): Record<string, unknown> {
    return {
      triggerKind: rule.triggerKind,
      version: rule.version,
      capScope: rule.capScope,
      capCount: rule.capCount,
      holdHours: rule.holdHours,
      reversalPolicy: rule.reversalPolicy,
      isActive: rule.isActive,
      triggerConfig: input.triggerConfig,
      benefits: input.benefits.map((b) => ({
        benefitKind: b.benefitKind,
        awardMode: b.awardMode,
        awardCap: b.awardCap,
        config: b.config,
      })),
      conditions: input.conditions.map((c) => ({
        conditionKind: c.conditionKind,
        config: c.config,
      })),
    };
  }

  /**
   * Refuses the combinations the schema cannot.
   *
   * A CHECK ties award_mode to award_cap, but it cannot know that a free coffee
   * is discrete. Only the handler knows, so the registry is asked — which is
   * what stops a factor of 0.6 producing six tenths of a coffee.
   */
  /**
   * A rule that grants money needs to know in what.
   *
   * A benefit may name its own currency — a promotion paying in something
   * other than the usual — and when it does, this has nothing to say. When it
   * does not, the answer is the business's currency, and a business that has
   * never chosen one has no answer. Refused HERE rather than at grant time,
   * because a rule saved today and silently skipped in three weeks is the
   * worst version of this: the screen said it worked.
   *
   * ITS OWN ERROR CODE, not a validation failure, because the remedy is a
   * different screen. The client is expected to recognise it, say so, and
   * offer to take them to business settings — which it cannot do if the
   * refusal only says "invalid".
   *
   * A POINTS RULE IS UNAFFECTED, deliberately. Points are not money and need
   * no currency, so a business with none configured can still run a full
   * points programme and is never asked a question it does not need to answer.
   */
  /**
   * A rule that counts days needs to know where the day starts.
   *
   * Two things need a calendar: a frequency cap — "once a day" has to know
   * when the day turns over — and a time window, because "Tuesday 6pm" means
   * nothing without a place. A rule with neither needs no timezone and is
   * never asked for one, exactly as a points rule is never asked for a
   * currency.
   *
   * Refused at CREATION rather than at grant time. The runtime path fails
   * closed too, which is right, but a rule saved today and silently skipping
   * every event in three weeks is the version of this that nobody notices
   * until the awards are missing.
   */
  /**
   * Refuses a programme the business is not configured to run.
   *
   * Exactly the two guards a rule gets, asked once for the whole programme
   * rather than once per expanded rule — the person filling in the form sees
   * one refusal naming what is missing, not the same refusal repeated per
   * trigger they ticked.
   */
  private static assertProgramCanRun(
    input: CreateRewardProgramInput,
    businessTimezone: string | null,
    businessCurrency: string | null,
  ): void {
    const asRule = {
      capScope: input.capScope,
      conditions: RewardsService.scheduleToConditions(input.schedule),
      benefits: input.benefits,
    };
    RewardsService.assertMoneyHasACurrency(asRule, businessCurrency);
    RewardsService.assertCalendarRulesHaveATimezone(asRule, businessTimezone);
  }

  /**
   * Turns the schedule a person filled in into the condition the engine reads.
   *
   * THEY ARE TRANSPOSES OF EACH OTHER. Somebody ticks Friday and then says
   * when on Friday; the engine holds slots, each naming the days it covers.
   * Converting here means the client never learns the engine's shape and the
   * engine never learns the form's.
   *
   * A DAY WITH NO SLOTS MEANS ALL OF IT, expressed as 00:00 to 23:59.
   *
   * It was written as 00:00 to 00:00, which reads like "midnight to midnight"
   * and is wrong: the condition takes `start <= end` as an ordinary window
   * and asks `minutes >= 0 && minutes < 0`, which is false at every instant.
   * A ticked day with no hours therefore matched NOTHING — the exact opposite
   * of what it says — and the test that covered it asserted the stored shape
   * rather than whether it ever fires.
   *
   * 23:59 is read as the end of the day by `endMinute`, so this covers every
   * minute including the last.
   *
   * NO DAYS AT ALL MEANS NO CONDITION. An empty condition list is "always",
   * never "never": the absence of a restriction must not silently disable the
   * programme nobody configured.
   */
  private static scheduleToConditions(
    schedule: CreateRewardProgramInput['schedule'],
  ): RewardConditionConfig[] {
    if (schedule.days.length === 0) return [];

    const slots = schedule.days.flatMap((day) =>
      day.slots.length === 0
        ? [{ days: [day.isoDay], start: '00:00', end: '23:59' }]
        : day.slots.map((slot) => ({ days: [day.isoDay], start: slot.start, end: slot.end })),
    );

    return [
      { conditionKind: RewardConditionKind.TimeWindow, config: { slots } },
    ] as RewardConditionConfig[];
  }

  /**
   * The inverse of `scheduleToConditions`: slots back into days.
   *
   * The engine stores a list of slots, each naming the days it applies to;
   * the form asks day by day. Neither shape is wrong — they answer different
   * questions — and the conversion belongs in ONE place, beside the function
   * it reverses, rather than in whichever client needs it.
   *
   * A whole-day window comes back as a day with NO slots, which is how the
   * form says "all of this day". Recognising `00:00`–`23:59` here is what
   * stops a round trip turning "all day" into an explicit window that merely
   * looks like one.
   */
  private static conditionsToSchedule(
    conditions: readonly RewardConditionConfig[],
  ): { isoDay: number; slots: { start: string; end: string }[] }[] {
    const byDay = new Map<number, { start: string; end: string }[]>();

    for (const condition of conditions) {
      if (condition.conditionKind !== RewardConditionKind.TimeWindow) continue;
      const slots = (
        condition.config as { slots?: { days: number[]; start: string; end: string }[] }
      ).slots;
      if (!slots) continue;

      for (const slot of slots) {
        for (const isoDay of slot.days) {
          const held = byDay.get(isoDay) ?? [];
          /* The whole day is the ABSENCE of a slot, not a slot covering it. */
          if (!(slot.start === '00:00' && slot.end === '23:59')) {
            held.push({ start: slot.start, end: slot.end });
          }
          byDay.set(isoDay, held);
        }
      }
    }

    return [...byDay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([isoDay, slots]) => ({ isoDay, slots }));
  }

  /**
   * A programme as the edit form needs it — the same shape its PUT accepts.
   *
   * ONE READ THAT ROUND TRIPS. The form that edits a programme is the form
   * that created it, so what it loads has to be what it will send back. Giving
   * the client the rule rows and letting it fold them into a programme would
   * put the create path's expansion logic in two places, and the copy in the
   * browser would be the one that goes stale.
   *
   * ONLY ACTIVE RULES. The retired versions are the history; they are what an
   * old award resolves against, not what the programme is now.
   *
   * `uniform` IS NOT DECORATION. The composite path writes one rule per
   * trigger with identical settings, so flattening them back is lossless. A
   * programme whose rules were added one at a time through `POST
   * /rewards/rules` can have rules that genuinely differ — and saving this
   * form would then overwrite all of them with one shared answer. Saying so
   * lets the client warn before that happens instead of after.
   */
  async programConfiguration(enterpriseId: number, refId: string) {
    const program = await this.programs.findByRefId(enterpriseId, refId);
    if (!program) throw new AppException(ErrorCode.RewardProgramNotFound);

    const rules = (await this.rules.listForProgram(enterpriseId, program.id, DEFAULT_PAGE)).filter(
      (rule) => rule.isActive,
    );

    const first = rules[0];
    /*
     * THE FIRST ACTIVE RULE'S, and `uniform` below says whether that is the
     * whole truth. The composite path writes the same benefits and conditions
     * onto every rule it creates, so reading one is reading all of them.
     */
    const benefits = first
      ? await this.rules.loadBenefits(enterpriseId, first.id, first.version)
      : [];
    const conditions = first
      ? await this.rules.loadConditions(enterpriseId, first.id, first.version)
      : [];

    const uniform = rules.every(
      (rule) =>
        rule.capScope === first?.capScope &&
        rule.capCount === first?.capCount &&
        rule.holdHours === first?.holdHours,
    );

    const balanceRule = rules.find(
      (rule) => rule.triggerKind === RewardTriggerKind.PointsBalanceReached,
    );
    const minPointsBalance = (
      balanceRule?.triggerConfig as { minPointsBalance?: number } | undefined
    )?.minPointsBalance;

    return {
      refId: program.refId,
      name: program.name,
      displayName: program.displayName,
      status: program.status,
      version: program.version,
      destination: program.forwardProviderCode === null ? 'internal' : 'external',
      triggers: rules.map((rule) => rule.triggerKind),
      ...(minPointsBalance === undefined ? {} : { minPointsBalance }),
      capScope: first?.capScope ?? RewardCapScope.None,
      capCount: first?.capCount ?? 1,
      holdHours: first?.holdHours ?? 0,
      benefits: benefits.map((benefit) => ({
        benefitKind: benefit.benefitKind,
        awardMode: benefit.awardMode,
        awardCap: benefit.awardCap,
        config: benefit.config,
      })),
      schedule: {
        startsAt: program.startsAt,
        endsAt: program.endsAt,
        days: RewardsService.conditionsToSchedule(
          conditions.map((c) => ({
            conditionKind: c.conditionKind,
            config: c.config,
          })) as RewardConditionConfig[],
        ),
      },
      /* False = these rules do not agree; saving this form would flatten them. */
      uniform,
    };
  }

  private static assertCalendarRulesHaveATimezone(
    /* Only what it reads. Declared as the whole rule input, a programme could
     * not reuse it without inventing a programRefId it does not have. */
    input: { capScope: RewardCapScope; conditions: readonly RewardConditionConfig[] },
    businessTimezone: string | null,
  ): void {
    if (businessTimezone !== null) return;

    const reasons: string[] = [];
    if (input.capScope !== RewardCapScope.None) {
      reasons.push(
        `a cap of "once per ${input.capScope}" needs to know when the period turns over`,
      );
    }
    if (input.conditions.some((c) => c.conditionKind === RewardConditionKind.TimeWindow)) {
      reasons.push('a time window needs to know what hour it is for this business');
    }
    if (reasons.length === 0) return;

    throw new AppException(ErrorCode.EnterpriseTimezoneNotSet, {
      details: reasons.map((issue) => ({ field: 'timezone', issue })),
    });
  }

  private static assertMoneyHasACurrency(
    input: { benefits: readonly RewardBenefitInput[] },
    businessCurrency: string | null,
  ): void {
    if (businessCurrency !== null) return;

    const unfunded = input.benefits.filter(
      (benefit) =>
        CURRENCY_BEARING_BENEFITS.has(benefit.benefitKind) &&
        (benefit.config as { currencyCode?: string }).currencyCode === undefined,
    );
    if (unfunded.length === 0) return;

    throw new AppException(ErrorCode.EnterpriseCurrencyNotSet, {
      details: unfunded.map((benefit) => ({
        field: 'benefits',
        issue: `${benefit.benefitKind} needs a currency, and this business has not set one`,
      })),
    });
  }

  private assertBenefitsAreCoherent(input: CreateRewardRuleInput): void {
    for (const benefit of input.benefits) {
      if (benefit.awardMode !== RewardAwardMode.UpTo) continue;

      if (!this.benefits.isScalable(benefit.benefitKind)) {
        throw new AppException(ErrorCode.RewardBenefitNotScalable, {
          details: [{ field: 'benefits', issue: `${benefit.benefitKind} cannot be "up to"` }],
        });
      }
      if (benefit.awardCap === null) {
        throw new AppException(ErrorCode.ValidationFailed, {
          details: [
            { field: 'awardCap', issue: 'an "up to" benefit needs a cap for the factor to scale' },
          ],
        });
      }
    }
  }

  async listRules(enterpriseId: number, programRefId: string) {
    const program = await this.programs.findByRefId(enterpriseId, programRefId);
    if (!program) throw new AppException(ErrorCode.RewardProgramNotFound);
    return this.rules.listForProgram(enterpriseId, program.id, MAX_ROWS);
  }

  async setRuleActive(enterpriseId: number, refId: string, isActive: boolean) {
    return this.tx.runInTransaction(async () => {
      const moved = await this.rules.setActive(enterpriseId, refId, isActive);
      if (!moved) throw new AppException(ErrorCode.RewardRuleNotFound);

      const rule = await this.rules.findByRefId(enterpriseId, refId);

      await this.audit.record({
        action: AuditAction.Updated,
        entityType: AuditEntityType.RewardRule,
        entityId: rule?.id ?? null,
        enterpriseId,
        changes: { isActive },
      });

      /*
       * SWITCHING A RULE OFF IS THE EDIT THAT MATTERS MOST — it is the
       * difference between a customer earning and not — so it appends a
       * version like any other change. The snapshot carries the rule's own
       * shape; its benefits and conditions belong to a rule VERSION and are
       * immutable, so the create-time snapshot still describes them.
       */
      if (rule) {
        await this.versions.record({
          entityType: AuditEntityType.RewardRule,
          entityId: rule.id,
          enterpriseId,
          snapshot: {
            triggerKind: rule.triggerKind,
            version: rule.version,
            capScope: rule.capScope,
            capCount: rule.capCount,
            holdHours: rule.holdHours,
            reversalPolicy: rule.reversalPolicy,
            isActive,
          },
        });
      }

      return rule;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Balances                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * What a customer holds. SEVERAL NUMBERS, never one.
   *
   * Points and each currency are separate wallets and are never netted — a total
   * across them would be meaningless and wrong in every screen that showed it.
   */
  async getCustomerBalances(enterpriseId: number, customerRefId: string) {
    const customer = await this.customers.findByRefId(enterpriseId, customerRefId);
    if (!customer) throw new AppException(ErrorCode.CustomerNotFound);

    const [wallets, entitlements] = await Promise.all([
      this.wallets.listCustomerWallets(enterpriseId, customer.id, MAX_ROWS),
      this.entitlements.listForCustomer(enterpriseId, customer.id, MAX_ROWS),
    ]);

    return { customerRefId, wallets, entitlements };
  }

  async getWalletStatement(enterpriseId: number, customerRefId: string, walletRefId: string) {
    const { wallets } = await this.getCustomerBalances(enterpriseId, customerRefId);
    const wallet = wallets.find((w) => w.refId === walletRefId);
    if (!wallet) throw new AppException(ErrorCode.RewardWalletNotFound);

    const entries = await this.wallets.listEntries(enterpriseId, wallet.id, DEFAULT_PAGE);
    return { wallet, entries };
  }

  /**
   * A human moving value for one named customer.
   *
   * TWO RECORDS, TWO JOBS. The audit row answers "who touched this account?";
   * the ledger entry answers "why is the balance what it is?" and carries its
   * own actor, because it must stand alone when Finance reads the ledger
   * without the audit table beside it.
   *
   * Unchecked on purpose: an adjustment is one of only two things allowed to
   * drive a balance negative (the other is a reversal). Rule evaluation never
   * can.
   */
  async adjustBalance(enterpriseId: number, input: AdjustRewardBalanceInput) {
    const customer = await this.customers.findByRefId(enterpriseId, input.customerRefId);
    if (!customer) throw new AppException(ErrorCode.CustomerNotFound);

    const actor = RequestContext.actor();

    const entry = await this.tx.runInTransaction(async () => {
      const wallet = await this.wallets.ensureCustomerWallet({
        enterpriseId,
        customerId: customer.id,
        walletKind: input.walletKind,
        currencyCode: input.walletKind === RewardWalletKind.Points ? null : input.currencyCode,
      });

      const posted = await this.wallets.postUnchecked({
        enterpriseId,
        walletId: wallet.id,
        entryKind: RewardEntryKind.Adjust,
        amount: input.amount,
        /*
         * Random, and that is correct HERE where it is wrong everywhere else.
         * An adjustment has no natural key — the same employee may legitimately
         * credit the same customer the same amount twice — so deriving a key
         * would silently collapse the second into the first.
         */
        idempotencyKey: `adjust:${randomUUID()}`,
        occurredAtUtc: new Date(),
        actorKind: actor?.actorKind ?? ActorKind.System,
        actorId: actor?.employeeId ?? null,
        reasonCode: 'manual_adjustment',
      });

      /*
       * INSIDE the transaction, with the ledger entry it describes. A human
       * moved value for a named customer — the one reward action with a person
       * behind it — so a record that could outlive a rolled-back entry, or go
       * missing after a committed one, is the wrong trade either way.
       */
      await this.audit.record({
        action: AuditAction.Adjusted,
        entityType: AuditEntityType.RewardWallet,
        entityId: posted.walletId,
        enterpriseId,
        changes: {
          customerRefId: input.customerRefId,
          walletKind: input.walletKind,
          amount: input.amount,
          balanceAfter: posted.balanceAfter,
        },
        metadata: { reason: input.reason, ledgerEntryRefId: posted.refId },
      });

      return posted;
    });

    return entry;
  }

  /* ------------------------------------------------------------------ */
  /* History                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * What a customer earned, and what they did not.
   *
   * Skipped awards are included deliberately. "Why didn't I get my points?" is
   * the question this screen exists to answer, and a row saying `skipped_cap`
   * with its period key answers it without an investigation.
   */
  async listAwards(enterpriseId: number, customerRefId: string) {
    const customer = await this.customers.findByRefId(enterpriseId, customerRefId);
    if (!customer) throw new AppException(ErrorCode.CustomerNotFound);

    return this.awards.listForCustomer(enterpriseId, customer.id, DEFAULT_PAGE);
  }
}
