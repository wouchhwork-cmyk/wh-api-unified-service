import { Injectable, Logger } from '@nestjs/common';
import { RewardAwardRepository } from '@/database/repositories/reward-award.repository';
import { RewardProgramRepository } from '@/database/repositories/reward-program.repository';
import { RewardRuleRepository } from '@/database/repositories/reward-rule.repository';
import { TransactionManager } from '@/database/transaction/transaction.manager';
import {
  AuditAction,
  AuditEntityType,
  RewardAwardStatus,
  RewardReversalPolicy,
  RewardTriggerKind,
} from '@/shared/enums';
import { AuditService } from '@/modules/audit';
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
/**
 * What one held award's transaction decided.
 *
 * A shape rather than a boolean because the caller needs three facts and only
 * one of them is "did it grant": whether points moved, and under which trigger,
 * decide whether a threshold offer follows and whether it would recurse.
 */
type GrantOutcome =
  | { readonly granted: false }
  | {
      readonly granted: true;
      readonly creditedPoints: boolean;
      readonly triggerKind: RewardTriggerKind;
    };

const NOT_GRANTED: GrantOutcome = { granted: false };

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
    private readonly audit: AuditService,
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
      const { enterpriseId } = award;
      let credited: RewardTriggerKind | null = null;
      try {
        const outcome = await this.tx.runInTransaction(async (): Promise<GrantOutcome> => {
          /*
           * Another instance may already be granting this one. The sweep listed
           * it a moment ago and nothing stopped a second worker listing it too.
           */
          const mine = await this.awards.lockHeldAward(enterpriseId, award.id);
          if (!mine) return NOT_GRANTED;

          const rule = await this.rules.findById(enterpriseId, award.ruleId);
          if (!rule) return NOT_GRANTED;
          const program = await this.programs.findById(enterpriseId, rule.programId);
          if (!program) return NOT_GRANTED;

          const benefits = await this.rules.loadBenefits(
            enterpriseId,
            award.ruleId,
            award.ruleVersion,
          );

          const creditedPoints = await this.evaluator.grant({
            enterpriseId,
            awardId: award.id,
            customerId: award.customerId,
            rule,
            programTimezone: program.enterpriseTimezone,
            defaultCurrencyCode: program.enterpriseCurrencyCode,
            periodKey: award.periodKey,
            occurredAtUtc: award.occurredAtUtc,
            benefits,
          });
          return { granted: true, creditedPoints, triggerKind: rule.triggerKind };
        });

        if (!outcome.granted) continue;
        granted += 1;
        if (outcome.creditedPoints) credited = outcome.triggerKind;
      } catch (error) {
        this.logger.error(`granting held award ${award.id} failed: ${(error as Error).message}`);
        continue;
      }

      /*
       * The same offer the immediate path makes, for the same reason and in the
       * same place: AFTER the commit. A held award credits points hours later,
       * and a threshold rule that could only see immediate grants would be half
       * a feature.
       *
       * Its own try, so a failed offer is not logged as a failed grant — the
       * grant is committed and counted by this point.
       */
      if (credited === null) continue;
      try {
        await this.evaluator.offerBalanceThresholds({
          enterpriseId,
          customerId: award.customerId,
          occurredAtUtc: award.occurredAtUtc,
          awardId: award.id,
          grantingTriggerKind: credited,
        });
      } catch (error) {
        this.logger.error(
          `threshold offer after held award ${award.id} failed: ${(error as Error).message}`,
        );
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
          /*
           * Only a GRANTED award has anything to compensate. A held one wrote
           * no ledger entry and issued no entitlement, so there is nothing to
           * reverse — and asking the dispatcher to reverse nothing would log a
           * warning for every deleted comment that never earned.
           */
          if (award.status === RewardAwardStatus.Granted) {
            await this.dispatcher.compensateAward({
              enterpriseId: input.enterpriseId,
              awardId: award.id,
              customerId: award.customerId,
              ruleId: award.ruleId,
              ruleVersion: award.ruleVersion,
              occurredAtUtc: award.occurredAtUtc,
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

          /*
           * THE PLATFORM TOOK VALUE BACK. The counterpart to the grant, and
           * the more important of the two to record: a customer whose points
           * disappeared is owed an answer, and "the comment you earned them
           * for was deleted" is it.
           *
           * `system` again, and accurately — this runs in the projector worker
           * off a platform webhook, with no human anywhere in the stack.
           */
          await this.audit.record({
            action: AuditAction.Reversed,
            entityType: AuditEntityType.RewardAward,
            entityId: award.id,
            enterpriseId: input.enterpriseId,
            changes: { status: { from: award.status, to: RewardAwardStatus.Reversed } },
            metadata: {
              customerId: award.customerId,
              ruleId: award.ruleId,
              ruleVersion: award.ruleVersion,
              reasonCode: input.reasonCode,
            },
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
