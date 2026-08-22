import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import { GraphApiError } from '@/modules/connections/graph/graph-api.error';
import { mapGraphError } from '@/modules/connections/graph/graph-error.mapper';
import type {
  GraphComment,
  GraphConversation,
  GraphFeedPost,
} from '@/modules/connections/graph/graph.types';
import { TokenCipherService } from '@/shared/crypto/token-cipher.service';
import { scheduleRetry } from '@/modules/ledger/backoff.util';
import { inboundDedupKey } from '@/modules/ledger/dedup-key.util';
import {
  SYNC_COMMENTS_PER_POST,
  SYNC_MAX_ATTEMPTS,
  SYNC_MAX_PAGES_PER_RUN,
  SYNC_RATE_LIMIT_PARK_MS,
} from '@/shared/constants';
import { EventPriority, InboundEventType, Platform, SourceKind, SyncJobKind } from '@/shared/enums';
import { ErrorCode } from '@/shared/errors';
import { BasePoller } from './base-poller';

/**
 * The kinds this worker can actually walk. Anything else is paused rather than
 * silently routed to the wrong walk.
 */
const IMPLEMENTED_JOB_KINDS: ReadonlySet<SyncJobKind> = new Set([
  SyncJobKind.BackfillComments,
  SyncJobKind.BackfillConversations,
]);

interface ClaimedSyncJob {
  readonly id: number;
  readonly enterpriseId: number;
  readonly channelId: number;
  readonly jobKind: SyncJobKind;
  readonly pageCursor: string | null;
  readonly attemptCount: number;
}

/** What one slice of a walk produced. */
interface SliceResult {
  readonly itemsAdded: number;
  readonly nextCursor: string | null;
  readonly finished: boolean;
}

/**
 * Copies history that predates the connection.
 *
 * THE KEY DECISION: backfill does NOT write domain rows. It fetches from Graph,
 * synthesises the SAME payload shape a webhook would have delivered, and appends
 * it to inbound_events. The existing projectors then do the projecting.
 *
 * That buys three things no separate write path could:
 *   - one implementation of "what a comment means", so history and live traffic
 *     can never diverge;
 *   - free deduplication against live webhooks, because the dedup key is
 *     composed identically — a comment that arrives by webhook while the
 *     backfill is walking is stored once, by whichever got there first;
 *   - free retries, because a half-finished slice leaves ledger rows that are
 *     idempotent to re-insert.
 *
 * A run takes at most SYNC_MAX_PAGES_PER_RUN pages and saves its cursor, so no
 * job holds its lease for a whole history and a crash costs one slice.
 */
@Injectable()
export class BackfillWorker extends BasePoller {
  protected readonly name = 'backfill';

  constructor(
    private readonly syncJobs: SyncJobRepository,
    private readonly channels: ChannelRepository,
    private readonly inbound: InboundEventRepository,
    private readonly graph: GraphApiClient,
    private readonly cipher: TokenCipherService,
    protected readonly config: AppConfigService,
    @InjectPinoLogger(BackfillWorker.name) protected readonly logger: PinoLogger,
  ) {
    super();
  }

  protected async pollOnce(): Promise<number> {
    const { batchSize, leaseSeconds } = this.config.worker;
    const claimed = await this.syncJobs.claimBatch(this.leaseOwner, batchSize, leaseSeconds);

    for (const job of claimed) {
      await this.runJob(job, leaseSeconds);
    }
    return claimed.length;
  }

  private async runJob(job: ClaimedSyncJob, leaseSeconds: number): Promise<void> {
    const channel = await this.channels.findSendContext(job.enterpriseId, job.channelId);

    if (!channel) {
      await this.syncJobs.markPaused(job.id, this.leaseOwner, 'the channel no longer exists');
      return;
    }
    if (channel.reauthRequired) {
      await this.syncJobs.markPaused(
        job.id,
        this.leaseOwner,
        'the channel needs re-authorisation before its history can be read',
      );
      return;
    }
    if (!channel.effectiveAccessToken) {
      await this.syncJobs.markPaused(job.id, this.leaseOwner, 'the channel has no usable token');
      return;
    }

    /*
     * Instagram reads a different set of edges entirely (/media, not /feed) and
     * is not implemented. PAUSED with a reason rather than completed-with-zero:
     * completing would claim the history was copied when nothing was read.
     */
    if (channel.platform !== Platform.Facebook) {
      await this.syncJobs.markPaused(
        job.id,
        this.leaseOwner,
        `backfill is not implemented for platform "${channel.platform}" yet`,
      );
      return;
    }

    /*
     * Only these two kinds are implemented. The dispatch below would otherwise
     * fall through to the comment walk for ANY kind, so backfill_posts would
     * quietly re-copy comments — the same rows as backfill_comments, under a
     * job that claims to be about posts.
     *
     * backfill_posts needs somewhere to put a post, and there is no posts
     * repository or post projector yet; refresh_* are scheduled refreshes, not
     * history walks. Paused with a reason, so the job says what it is waiting
     * for instead of reporting success it did not achieve.
     */
    if (!IMPLEMENTED_JOB_KINDS.has(job.jobKind)) {
      await this.syncJobs.markPaused(
        job.id,
        this.leaseOwner,
        `sync kind "${job.jobKind}" is not implemented yet`,
      );
      return;
    }

    let token: string;
    try {
      token = this.cipher.decrypt(channel.effectiveAccessToken);
    } catch (error) {
      // Same reasoning as the relay: a decryption failure is key loss or
      // tampering, not a missing token, and must be loud.
      this.logger.error(
        { channelId: job.channelId, err: error },
        'could not decrypt a channel token — key loss or tampering',
      );
      await this.syncJobs.markPaused(
        job.id,
        this.leaseOwner,
        'the channel token could not be decrypted',
      );
      return;
    }

    const correlationId = randomUUID();

    try {
      const result = await this.walk(
        job,
        channel.platformChannelId,
        token,
        correlationId,
        leaseSeconds,
      );

      if (result.finished) {
        await this.syncJobs.markCompleted(job.id, this.leaseOwner, result.itemsAdded);
        this.logger.info(
          { jobKind: job.jobKind, channelId: job.channelId, correlationId },
          'backfill finished',
        );
      }
    } catch (error) {
      await this.handleFailure(job, error);
    }
  }

  /**
   * Walks up to SYNC_MAX_PAGES_PER_RUN pages, saving the cursor after each.
   *
   * Progress is saved per page rather than per run so that a lease lost halfway
   * has still advanced the job. saveProgress is fenced on the lease: a false
   * return means another worker owns this job now and this one must stop
   * writing, or the two would rewind each other's cursor.
   */
  private async walk(
    job: ClaimedSyncJob,
    platformChannelId: string,
    token: string,
    correlationId: string,
    leaseSeconds: number,
  ): Promise<SliceResult> {
    let cursor = job.pageCursor;
    let itemsAdded = 0;

    for (let page = 0; page < SYNC_MAX_PAGES_PER_RUN; page += 1) {
      const slice =
        job.jobKind === SyncJobKind.BackfillConversations
          ? await this.conversationPage(job, platformChannelId, token, correlationId, cursor)
          : await this.commentPage(job, platformChannelId, token, correlationId, cursor);

      itemsAdded += slice.itemsAdded;
      cursor = slice.nextCursor;

      if (slice.finished) {
        return { itemsAdded, nextCursor: null, finished: true };
      }

      const held = await this.syncJobs.saveProgress(
        job.id,
        this.leaseOwner,
        cursor,
        slice.itemsAdded,
        leaseSeconds,
      );
      if (!held) {
        this.logger.warn(
          { jobId: job.id, jobKind: job.jobKind },
          'lease lapsed mid-walk — another worker owns this job now',
        );
        return { itemsAdded, nextCursor: cursor, finished: false };
      }
      itemsAdded = 0; // already banked by saveProgress
    }

    // Out of pages, not out of history: the next poll continues from the cursor.
    return { itemsAdded: 0, nextCursor: cursor, finished: false };
  }

  /** One page of the feed, emitting a ledger row per comment found. */
  private async commentPage(
    job: ClaimedSyncJob,
    pageId: string,
    token: string,
    correlationId: string,
    cursor: string | null,
  ): Promise<SliceResult> {
    const edge = await this.graph.listPagePosts(pageId, token, {
      ...(cursor === null ? {} : { after: cursor }),
      withComments: true,
    });

    let added = 0;
    for (const post of edge.data ?? []) {
      added += await this.emitComments(job, post, correlationId);
    }

    return {
      itemsAdded: added,
      nextCursor: edge.paging?.cursors?.after ?? null,
      finished: !edge.paging?.next,
    };
  }

  private async emitComments(
    job: ClaimedSyncJob,
    post: GraphFeedPost,
    correlationId: string,
  ): Promise<number> {
    const comments = post.comments?.data ?? [];

    // No silent caps: a post with more comments than one nested page holds is
    // reported, because the rest are NOT copied by this walk.
    if (comments.length >= SYNC_COMMENTS_PER_POST) {
      this.logger.warn(
        { postId: post.id, copied: comments.length, channelId: job.channelId },
        'post has more comments than one nested page — the remainder is not backfilled',
      );
    }

    let added = 0;
    for (const comment of comments) {
      if (await this.appendComment(job, post, comment, correlationId)) added += 1;
    }
    return added;
  }

  private async appendComment(
    job: ClaimedSyncJob,
    post: GraphFeedPost,
    comment: GraphComment,
    correlationId: string,
  ): Promise<boolean> {
    if (!comment.id) return false;

    /*
     * The webhook's own shape, field for field. `verb: 'add'` is part of the
     * dedup identity exactly as composeDedupKey builds it, so a historical
     * comment and the live webhook for that same comment collide and are stored
     * once.
     */
    const payload = {
      field: 'feed',
      value: {
        item: 'comment',
        verb: 'add',
        comment_id: comment.id,
        parent_id: comment.parent?.id ?? post.id,
        post_id: post.id,
        message: comment.message,
        created_time: toUnixSeconds(comment.created_time),
        from: comment.from ? { id: comment.from.id, name: comment.from.name } : undefined,
      },
    };

    const result = await this.inbound.insertIgnoringDuplicate({
      enterpriseId: job.enterpriseId,
      channelId: job.channelId,
      sourceKind: SourceKind.Channel,
      sourceId: post.id,
      platform: Platform.Facebook,
      eventType: InboundEventType.Comment,
      platformEventId: comment.id,
      dedupKey: inboundDedupKey(Platform.Facebook, InboundEventType.Comment, `${comment.id}:add`),
      correlationId,
      payload,
      // Backfill must never crowd out live traffic: a customer messaging now
      // waits behind nothing, because the claim orders on priority first.
      priority: EventPriority.Low,
      receivedAt: parseTimestamp(comment.created_time),
    });

    return !result.duplicate;
  }

  /** One page of message threads, emitting a ledger row per message. */
  private async conversationPage(
    job: ClaimedSyncJob,
    pageId: string,
    token: string,
    correlationId: string,
    cursor: string | null,
  ): Promise<SliceResult> {
    const edge = await this.graph.listPageConversations(pageId, token, cursor ?? undefined);

    let added = 0;
    for (const conversation of edge.data ?? []) {
      added += await this.emitMessages(job, pageId, conversation, correlationId);
    }

    return {
      itemsAdded: added,
      nextCursor: edge.paging?.cursors?.after ?? null,
      finished: !edge.paging?.next,
    };
  }

  private async emitMessages(
    job: ClaimedSyncJob,
    pageId: string,
    conversation: GraphConversation,
    correlationId: string,
  ): Promise<number> {
    let added = 0;

    for (const message of conversation.messages?.data ?? []) {
      if (!message.id) continue;

      const senderId = message.from?.id ?? null;
      /*
       * is_echo is DERIVED here, and it matters: a thread contains the Page's
       * own replies as well as the customer's messages. The projector already
       * skips echoes, so marking them keeps the Page from being projected as a
       * customer of itself.
       */
      const isEcho = senderId !== null && senderId === pageId;

      const payload = {
        sender: { id: senderId ?? undefined },
        recipient: { id: pageId },
        timestamp: toUnixMilliseconds(message.created_time),
        message: {
          mid: message.id,
          text: message.message,
          is_echo: isEcho,
        },
      };

      const result = await this.inbound.insertIgnoringDuplicate({
        enterpriseId: job.enterpriseId,
        channelId: job.channelId,
        sourceKind: SourceKind.Channel,
        sourceId: conversation.id,
        platform: Platform.Facebook,
        eventType: InboundEventType.DirectMessage,
        platformEventId: message.id,
        // Messages carry no verb, matching composeDedupKey's id-only branch.
        dedupKey: inboundDedupKey(Platform.Facebook, InboundEventType.DirectMessage, message.id),
        correlationId,
        payload,
        priority: EventPriority.Low,
        receivedAt: parseTimestamp(message.created_time),
      });

      if (!result.duplicate) added += 1;
    }

    return added;
  }

  /**
   * Decides what a Graph failure means for the job.
   *
   * A rate limit is PARKED rather than retried on the normal backoff: retrying
   * spends the same exhausted quota and deepens the limit. Re-auth is paused,
   * because no number of attempts fixes a dead token.
   */
  private async handleFailure(job: ClaimedSyncJob, error: unknown): Promise<void> {
    if (!(error instanceof GraphApiError)) {
      const message = error instanceof Error ? error.message : 'backfill failed';
      const retry = scheduleRetry(job.attemptCount, SYNC_MAX_ATTEMPTS);
      await this.syncJobs.markFailed(
        job.id,
        this.leaseOwner,
        message,
        retry?.nextAttemptAt ?? null,
      );
      return;
    }

    const mapped = mapGraphError(error);

    if (mapped.code === ErrorCode.UpstreamRateLimited) {
      const until = new Date(Date.now() + SYNC_RATE_LIMIT_PARK_MS);
      await this.syncJobs.markRateLimited(job.id, this.leaseOwner, until, error.message);
      this.logger.warn(
        { jobId: job.id, jobKind: job.jobKind, until: until.toISOString() },
        'backfill parked by a platform rate limit',
      );
      return;
    }

    if (mapped.requiresReauth) {
      await this.syncJobs.markPaused(job.id, this.leaseOwner, error.message);
      return;
    }

    /*
     * A permission gap is PAUSED, not dead-lettered. Both are terminal, but they
     * say different things to whoever reads the row: dead_letter means "we tried
     * and gave up", while this is "blocked on a scope this app was never
     * granted" — fixed by changing the Login configuration and reconnecting, not
     * by retrying. Reporting it as dead means a real, fixable gap looks like a
     * bug in us.
     */
    if (mapped.code === ErrorCode.PermissionDenied) {
      await this.syncJobs.markPaused(job.id, this.leaseOwner, error.message);
      this.logger.warn(
        { jobId: job.id, jobKind: job.jobKind, graphCode: error.code },
        'backfill blocked by a missing platform permission — the connection needs a wider scope',
      );
      return;
    }

    const retry = mapped.retryable ? scheduleRetry(job.attemptCount, SYNC_MAX_ATTEMPTS) : null;
    await this.syncJobs.markFailed(
      job.id,
      this.leaseOwner,
      error.message,
      retry?.nextAttemptAt ?? null,
    );
  }
}

/** Graph sends ISO-8601 for reads; webhooks send unix seconds. */
function toUnixSeconds(value: string | undefined): number | undefined {
  const parsed = parseTimestamp(value);
  return parsed === null ? undefined : Math.floor(parsed.getTime() / 1000);
}

function toUnixMilliseconds(value: string | undefined): number | undefined {
  const parsed = parseTimestamp(value);
  return parsed === null ? undefined : parsed.getTime();
}

function parseTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
