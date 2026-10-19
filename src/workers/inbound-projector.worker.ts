import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { CommentProjectorService } from '@/modules/inbox/comment-projector.service';
import { DirectMessageProjectorService } from '@/modules/inbox/direct-message-projector.service';
import { PostProjectorService } from '@/modules/inbox/post-projector.service';
import { MAX_PROJECTION_ATTEMPTS } from '@/shared/constants';
import { InboundEventType, Platform } from '@/shared/enums';
import { scheduleRetry } from '@/modules/ledger/backoff.util';
import { BasePoller } from './base-poller';
import type {
  ProjectedReversalFacts,
  ProjectedTriggerFacts,
  ProjectionOutcome,
} from '@/modules/inbox/comment-projector.service';
import { RewardGrantService } from '@/modules/rewards/reward-grant.service';
import { RuleEvaluatorService } from '@/modules/rewards/rule-evaluator.service';
import { ConversationKind, RewardTriggerKind } from '@/shared/enums';

/**
 * Which reward trigger a projected conversation represents.
 *
 * A comment on OUR post and a comment on somebody else's that tags us are
 * different things to an enterprise writing a rule — one is engagement on
 * their own content, the other is reach into somebody else's audience — so
 * they are separate triggers rather than one with a flag.
 *
 * A kind absent from this map simply does not drive rewards.
 */
const TRIGGER_FOR_CONVERSATION: Partial<Record<ConversationKind, RewardTriggerKind>> = {
  [ConversationKind.CommentThread]: RewardTriggerKind.CommentOnOwnPost,
  [ConversationKind.Mention]: RewardTriggerKind.CommentOnMentionedPost,
  [ConversationKind.DirectMessage]: RewardTriggerKind.DirectMessageInbound,
};

/**
 * Projects ledger rows into the domain.
 *
 * The projector is selected on event_type, which is why that column exists.
 * Handlers for the V1 domain features are not built yet, so an event whose
 * projection has no handler is marked SKIPPED with a reason rather than being
 * retried forever or, worse, having domain rows invented for it. Skipped is a
 * terminal, visible state: the row is kept and can be replayed once the handler
 * exists.
 */
interface ProjectionContext {
  readonly enterpriseId: number;
  readonly channelId: number;
  readonly platform: Platform;
  readonly inboundEventId: number;
  /**
   * OUR OWN ids on the platform — the channel's, and its parent Page's where
   * there is one.
   *
   * Carried so a projector can recognise the business's own content. Meta
   * delivers our comments through the same webhook as a customer's, and nothing
   * filtered them, so each agent reply that echoed back created a customer
   * record for the business itself.
   */
  readonly ownPlatformIds: readonly string[];
  /**
   * Which attempt this is, so a projector can tell "not here YET" from "not
   * coming". Meta delivers some events out of order, and the difference decides
   * whether to wait for the ledger's next pass or act on what is missing.
   */
  readonly attemptCount: number;
}

type Projector = (context: ProjectionContext, payload: unknown) => Promise<ProjectionOutcome>;

@Injectable()
export class InboundProjectorWorker extends BasePoller {
  protected readonly name = 'inbound-projector';

  private readonly projectors = new Map<InboundEventType, Projector>();

  constructor(
    private readonly inbound: InboundEventRepository,
    private readonly channels: ChannelRepository,
    private readonly comments: CommentProjectorService,
    private readonly directMessages: DirectMessageProjectorService,
    private readonly posts: PostProjectorService,
    private readonly rewards: RuleEvaluatorService,
    private readonly rewardGrants: RewardGrantService,
    protected readonly config: AppConfigService,
    @InjectPinoLogger(InboundProjectorWorker.name) protected readonly logger: PinoLogger,
  ) {
    super();

    // Registration is explicit, so an unhandled event type is obvious rather
    // than silently defaulted into the wrong projector.
    this.projectors.set(InboundEventType.Comment, (context, payload) =>
      this.comments.project(
        context.enterpriseId,
        context.channelId,
        context.platform,
        context.inboundEventId,
        payload,
        context.ownPlatformIds,
      ),
    );
    this.projectors.set(InboundEventType.DirectMessage, (context, payload) =>
      this.directMessages.project(
        context.enterpriseId,
        context.channelId,
        context.platform,
        context.inboundEventId,
        payload,
        context.attemptCount,
      ),
    );
    this.projectors.set(InboundEventType.Mention, (context, payload) =>
      this.comments.projectMention(
        context.enterpriseId,
        context.channelId,
        context.platform,
        context.inboundEventId,
        payload,
        context.ownPlatformIds,
      ),
    );
    this.projectors.set(InboundEventType.PostUpdate, (context, payload) =>
      this.posts.project(
        context.enterpriseId,
        context.channelId,
        context.platform,
        context.inboundEventId,
        payload,
      ),
    );
  }

  protected async pollOnce(): Promise<number> {
    const { batchSize, leaseSeconds } = this.config.worker;
    const claimed = await this.inbound.claimBatch(this.leaseOwner, batchSize, leaseSeconds);

    for (const event of claimed) {
      const projector = this.projectors.get(event.eventType);

      if (!projector) {
        await this.inbound.markSkipped(
          event.id,
          this.leaseOwner,
          `no projector registered for event_type "${event.eventType}"`,
        );
        continue;
      }

      // A projection needs the tenant and the channel, which live on the row
      // rather than in the payload — deriving them from the payload would be a
      // cross-tenant write primitive.
      const context = await this.inbound.findProjectionContext(event.id);
      if (!context) {
        await this.inbound.markSkipped(
          event.id,
          this.leaseOwner,
          'the event names no enterprise or channel',
        );
        continue;
      }

      try {
        const outcome = await projector(
          {
            enterpriseId: context.enterpriseId,
            channelId: context.channelId,
            platform: context.platform,
            inboundEventId: event.id,
            // Both, filtered: an Instagram channel has a parent Page, a Page
            // does not.
            ownPlatformIds: [context.platformChannelId, context.parentPlatformChannelId].filter(
              (id): id is string => id !== null,
            ),
            // Already incremented by the claim, so the first pass reads 1.
            attemptCount: event.attemptCount,
          },
          event.payload,
        );

        if (outcome.projected) {
          await this.inbound.markProcessed(event.id, this.leaseOwner);
          await this.offerToRewards(outcome.trigger);
          await this.reverseRewards(outcome.reversal);
        } else {
          // Not an error: the event was understood and deliberately not
          // projected — an echo of our own send, a like rather than a comment,
          // or something already stored.
          await this.inbound.markSkipped(
            event.id,
            this.leaseOwner,
            outcome.reason ?? 'not projected',
          );
        }
      } catch (error) {
        // Per-row failure: the batch continues. Retry with jittered backoff, or
        // dead-letter when the budget is spent.
        const message = error instanceof Error ? error.message : 'projection failed';
        const retry = scheduleRetry(event.attemptCount, MAX_PROJECTION_ATTEMPTS);
        await this.inbound.markFailed(
          event.id,
          this.leaseOwner,
          message,
          retry?.nextAttemptAt ?? new Date(),
        );
        this.logger.warn(
          {
            // The error and its stack: this logged neither, so the one line that
            // reports a projection failure said only that one had happened.
            err: error,
            eventId: event.id,
            eventType: event.eventType,
            attempt: event.attemptCount,
            maxAttempts: MAX_PROJECTION_ATTEMPTS,
          },
          'projection failed',
        );
      }
    }

    return claimed.length;
  }
  /**
   * Offers a projected event to the reward engine.
   *
   * AFTER the projection is marked processed, and deliberately so. The reward
   * engine opens its own transaction per rule, and a rule misbehaving must
   * never hold up — or roll back — the customer's message appearing in the
   * inbox. The inbox is the product; rewards are a reaction to it.
   *
   * The cost of that choice is honest: a crash between marking processed and
   * this call loses the reward for that event. The alternative is worse —
   * coupling a customer's message to a reward rule's correctness — and the
   * ledger's exactly-once index means a replay of the whole event is safe if
   * recovery is ever wanted.
   */
  private async offerToRewards(trigger: ProjectedTriggerFacts | undefined): Promise<void> {
    if (!trigger) return;

    const triggerKind = TRIGGER_FOR_CONVERSATION[trigger.conversationKind];
    if (!triggerKind) return;

    try {
      await this.rewards.onTriggerEvent({
        enterpriseId: trigger.enterpriseId,
        customerId: trigger.customerId,
        triggerKind,
        sourceRefKind: trigger.sourceRefKind,
        sourceRefId: trigger.sourceRefId,
        channelId: trigger.channelId,
        occurredAtUtc: trigger.occurredAtUtc,
        content: trigger.content,
        /*
         * Not fetched. The tenure condition needs it, and loading a customer
         * row for every projected event to serve a condition most rules do not
         * use is the wrong trade — the condition fails closed without it,
         * which is the safe direction.
         */
        customerFirstSeenAt: null,
        /* An inbound message knows nothing about a balance; only a credit
         * does, and that is what produces the threshold event. */
        pointsBalance: null,
      });
    } catch (error) {
      // Never fails the projection. The event is already processed.
      this.logger.warn(
        { err: error, sourceRefId: trigger.sourceRefId },
        'reward evaluation failed for a projected event',
      );
    }
  }
  /**
   * The content behind an award was removed or hidden. Take the award back.
   *
   * Only rules that asked for it react — reversalPolicy is per rule, because
   * whether a deleted comment should cost the customer their points is a
   * business decision rather than a platform fact.
   *
   * Same placement and same reasoning as offerToRewards: after the event is
   * processed, and never able to fail it. A reversal that does not happen is
   * recoverable from the award row; a projection that does not happen is a
   * customer's message missing from the inbox.
   */
  private async reverseRewards(reversal: ProjectedReversalFacts | undefined): Promise<void> {
    if (!reversal) return;

    try {
      const reversed = await this.rewardGrants.reverseForDeletedContent(reversal);
      if (reversed > 0) {
        this.logger.info(
          { sourceRefId: reversal.sourceRefId, reversed, reason: reversal.reasonCode },
          'reward awards reversed for removed content',
        );
      }
    } catch (error) {
      this.logger.warn(
        { err: error, sourceRefId: reversal.sourceRefId },
        'reward reversal failed for removed content',
      );
    }
  }
}
