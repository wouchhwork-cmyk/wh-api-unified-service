import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { RewardAwardRepository } from '@/database/repositories/reward-award.repository';
import { RewardEntitlementRepository } from '@/database/repositories/reward-entitlement.repository';
import { RewardProgramRepository } from '@/database/repositories/reward-program.repository';
import { RewardRuleRepository } from '@/database/repositories/reward-rule.repository';
import { RewardWalletRepository } from '@/database/repositories/reward-wallet.repository';
import { TransactionManager } from '@/database/transaction/transaction.manager';
import { AuditService } from '@/modules/audit/audit.service';
import type {
  AdjustRewardBalanceInput,
  CreateRewardProgramInput,
  CreateRewardRuleInput,
} from '@/shared/contracts/rewards/reward.contract';
import {
  ActorKind,
  AuditAction,
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
    private readonly tx: TransactionManager,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Programs                                                            */
  /* ------------------------------------------------------------------ */

  async createProgram(enterpriseId: number, input: CreateRewardProgramInput) {
    const program = await this.programs.create({ enterpriseId, ...input });

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
      changes: { name: program.name, timezone: program.timezone, budgetMinor: program.budgetMinor },
    });

    return program;
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
    return program;
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
        status: program.status,
        budgetMinor: program.budgetMinor,
        budgetCurrencyCode: program.budgetCurrencyCode,
        spentMinor: program.spentMinor,
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

    const rule = await this.tx.runInTransaction(async () => {
      const created = await this.rules.insertRule({
        enterpriseId,
        programId: program.id,
        version: 1,
        supersedesRuleId: null,
        triggerKind: input.triggerKind,
        triggerConfig: input.triggerConfig,
        factorProviderCode: CONSTANT_ONE_FACTOR_PROVIDER,
        capScope: input.capScope,
        capCount: input.capCount,
        holdHours: input.holdHours,
        reversalPolicy: input.reversalPolicy,
        priority: input.priority,
      });

      await this.rules.insertBenefits(
        enterpriseId,
        created.id,
        created.version,
        input.benefits.map((b) => ({
          benefitKind: b.benefitKind,
          awardMode: b.awardMode,
          awardCap: b.awardCap,
          budgetCostMinor: b.budgetCostMinor,
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

      return created;
    });

    await this.audit.record({
      action: AuditAction.Created,
      entityType: AuditEntityType.RewardRule,
      entityId: rule.id,
      enterpriseId,
      changes: {
        triggerKind: rule.triggerKind,
        version: rule.version,
        benefitCount: input.benefits.length,
        conditionCount: input.conditions.length,
      },
    });

    return rule;
  }

  /**
   * Refuses the combinations the schema cannot.
   *
   * A CHECK ties award_mode to award_cap, but it cannot know that a free coffee
   * is discrete. Only the handler knows, so the registry is asked — which is
   * what stops a factor of 0.6 producing six tenths of a coffee.
   */
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
    return rule;
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

      return this.wallets.postUnchecked({
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
    });

    await this.audit.record({
      action: AuditAction.Adjusted,
      entityType: AuditEntityType.RewardWallet,
      entityId: entry.walletId,
      enterpriseId,
      changes: {
        customerRefId: input.customerRefId,
        walletKind: input.walletKind,
        amount: input.amount,
        balanceAfter: entry.balanceAfter,
      },
      metadata: { reason: input.reason, ledgerEntryRefId: entry.refId },
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
