import { Injectable, Logger } from '@nestjs/common';
import { RewardAwardRepository } from '@/database/repositories/reward-award.repository';
import { RewardProgramRepository } from '@/database/repositories/reward-program.repository';
import { RewardRuleRepository } from '@/database/repositories/reward-rule.repository';
import { TransactionManager } from '@/database/transaction/transaction.manager';
import { RewardAwardStatus, RewardReversalPolicy } from '@/shared/enums';
import { BenefitDispatcher } from './benefit-dispatcher.service';
import { RuleEvaluatorService } from './rule-evaluator.service';

/** One batch. Bounded so a backlog drains in slices rather than one long lock. */
const GRANT_BATCH_SIZE = 100;

/**
 * Awards whose hold has elapsed, and awards whose content has gone.
 *
 * The hold does two jobs at once: it is the window in which deleted content can
 * take the award back, and it is the settling time for the factor, because
 * engagement counts are near zero when a comment first arrives.
 */
@Injectable()
export class RewardGrantService {
  private readonly logger = new Logger(RewardGrantService.name);

  constructor(
    private readonly awards: RewardAwardRepository,
    private readonly rules: RewardRuleRepository,
    private readonly programs: RewardProgramRepository,
    private readonly evaluator: RuleEvaluatorService,
    private readonly dispatcher: BenefitDispatcher,
    private readonly tx: TransactionManager,
  ) {}

  /**
   * Grants everything whose hold has passed.
   *
   * Each award is its own transaction. One failing must not hold up the rest,
   * and a failure leaves the award `held` so the next tick retries it — which
   * is safe because the ledger's idempotency key is derived from the award and
   * the benefit index, so a replay writes nothing twice.
   */
  async grantDueAwards(): Promise<number> {
    const due = await this.awards.claimDueHeldAwards(GRANT_BATCH_SIZE);
    let granted = 0;

    for (const award of due) {
      const enterpriseId = (award as unknown as { enterpriseId: number }).enterpriseId;
      try {
        const didGrant = await this.tx.runInTransaction(async () => {
          /*
           * Another instance may already be granting this one. The sweep listed
           * it a moment ago and nothing stopped a second worker listing it too.
           */
          const mine = await this.awards.lockHeldAward(enterpriseId, award.id);
          if (!mine) return false;

          const rule = await this.rules.findById(enterpriseId, award.ruleId);
          if (!rule) return false;
          const program = await this.programs.findById(enterpriseId, rule.programId);
          if (!program) return false;

          const benefits = await this.rules.loadBenefits(
            enterpriseId,
            award.ruleId,
            award.ruleVersion,
          );

          await this.evaluator.grant({
            enterpriseId,
            awardId: award.id,
            customerId: award.customerId,
            rule,
            programTimezone: program.timezone,
            defaultCurrencyCode: program.defaultCurrencyCode,
            periodKey: award.periodKey,
            occurredAtUtc: award.occurredAtUtc,
            benefits,
            budgetCost: benefits.reduce((sum, b) => sum + b.budgetCostMinor, 0),
          });
          return true;
        });
        if (didGrant) granted += 1;
      } catch (error) {
        this.logger.error(`granting held award ${award.id} failed: ${(error as Error).message}`);
      }
    }

    return granted;
  }

  /**
   * Content was deleted or hidden. Take the award back.
   *
   * `unhidden` deliberately does NOT re-grant, and that is a decision rather
   * than an omission: re-granting needs a fresh cap slot the customer has
   * already consumed, hide/unhide cycling would be a farming loop, and
   * compensation is rarely symmetric anyway. Restoring value is an `adjust`
   * with a named actor and a permission behind it — visible, attributable, rare.
   */
  async reverseForDeletedContent(input: {
    enterpriseId: number;
    sourceRefKind: string;
    sourceRefId: number;
    reasonCode: 'content_removed' | 'content_hidden';
  }): Promise<number> {
    const affected = await this.awards.findBySource(input);
    let reversed = 0;

    for (const award of affected) {
      /*
       * Only a granted or held award can be reversed. One already reversed,
       * expired or skipped has nothing to take back, and reversing it twice
       * would be the double-reversal the ledger's one-reversal-per-entry index
       * refuses anyway — better to not attempt it than to rely on the refusal.
       */
      if (award.status !== RewardAwardStatus.Granted && award.status !== RewardAwardStatus.Held) {
        continue;
      }

      const rule = await this.rules.findById(input.enterpriseId, award.ruleId);
      if (!rule || rule.reversalPolicy !== RewardReversalPolicy.OnContentDeleted) continue;

      try {
        await this.tx.runInTransaction(async () => {
          if (award.status === RewardAwardStatus.Granted) {
            await this.dispatcher.compensateAward({
              enterpriseId: input.enterpriseId,
              awardId: award.id,
              customerId: award.customerId,
              ruleId: award.ruleId,
              ruleVersion: award.ruleVersion,
              occurredAtUtc: award.occurredAtUtc,
            });

            const benefits = await this.rules.loadBenefits(
              input.enterpriseId,
              award.ruleId,
              award.ruleVersion,
            );
            await this.awards.releaseBudget({
              enterpriseId: input.enterpriseId,
              programId: rule.programId,
              costMinor: benefits.reduce((sum, b) => sum + b.budgetCostMinor, 0),
            });
          }

          /*
           * The cap slot comes back whether the award granted or was merely
           * held. They did the thing and then undid it; holding their weekly
           * slot hostage to a deleted comment would be a worse outcome than
           * letting them try again.
           */
          if (award.periodKey) {
            await this.awards.releaseCapSlot({
              enterpriseId: input.enterpriseId,
              ruleId: award.ruleId,
              customerId: award.customerId,
              periodKey: award.periodKey,
            });
          }

          await this.awards.markReversed({
            enterpriseId: input.enterpriseId,
            awardId: award.id,
            reasonCode: input.reasonCode,
          });
        });
        reversed += 1;
      } catch (error) {
        this.logger.error(`reversing award ${award.id} failed: ${(error as Error).message}`);
      }
    }

    return reversed;
  }
}
