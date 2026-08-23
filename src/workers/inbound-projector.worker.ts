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
}

type Projector = (
  context: ProjectionContext,
  payload: unknown,
) => Promise<{ projected: boolean; reason?: string }>;

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
      ),
    );
    this.projectors.set(InboundEventType.DirectMessage, (context, payload) =>
      this.directMessages.project(
        context.enterpriseId,
        context.channelId,
        context.platform,
        context.inboundEventId,
        payload,
      ),
    );
    this.projectors.set(InboundEventType.Mention, (context, payload) =>
      this.comments.projectMention(
        context.enterpriseId,
        context.channelId,
        context.platform,
        context.inboundEventId,
        payload,
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
          },
          event.payload,
        );

        if (outcome.projected) {
          await this.inbound.markProcessed(event.id, this.leaseOwner);
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
          { eventId: event.id, eventType: event.eventType, attempt: event.attemptCount },
          'projection failed',
        );
      }
    }

    return claimed.length;
  }
}
