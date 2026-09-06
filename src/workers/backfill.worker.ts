import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import {
  ChannelRepository,
  type ChannelBackfillContext,
} from '@/database/repositories/channel.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import { GraphApiError } from '@/modules/connections/graph/graph-api.error';
import { mapGraphError } from '@/modules/connections/graph/graph-error.mapper';
import type {
  GraphComment,
  GraphConversation,
  GraphEdge,
  GraphMessageAttachment,
  GraphFeedPost,
  GraphInstagramComment,
  GraphInstagramMedia,
} from '@/modules/connections/graph/graph.types';
import { TokenCipherService } from '@/shared/crypto/token-cipher.service';
import { scheduleRetry } from '@/modules/ledger/backoff.util';
import { inboundDedupKey } from '@/modules/ledger/dedup-key.util';
import {
  SYNC_COMMENTS_PER_POST,
  SYNC_MESSAGES_PER_CONVERSATION,
  SYNC_MAX_ATTEMPTS,
  SYNC_MAX_PAGES_PER_RUN,
  SYNC_RATE_LIMIT_PARK_MS,
} from '@/shared/constants';
import {
  EventPriority,
  IdentifierKind,
  InboundEventType,
  Platform,
  SourceKind,
  SyncJobKind,
} from '@/shared/enums';
import { ErrorCode } from '@/shared/errors';
import { BasePoller } from './base-poller';
import { splitPersonName } from '@/shared/utils/person-name';

/**
 * The read edge's attachment shape, expressed the way a webhook would say it.
 *
 * Graph nests the link under `image_data`, `video_data` or `file_url` and names
 * no type at all; a webhook says `{ type, payload: { url } }`. Everything
 * downstream — GIF detection, story mentions, media kinds — is written against
 * the webhook shape, so the translation happens once, here.
 */
function toWebhookAttachments(
  attachments: readonly GraphMessageAttachment[],
  shares: readonly { link?: string }[] = [],
): { type: string; payload: { url: string } }[] {
  const translated: { type: string; payload: { url: string } }[] = [];

  /*
   * A SHARE IS NOT AN ATTACHMENT as far as Graph is concerned — it has its own
   * edge, and `attachments` comes back empty for one. So a shared reel arrived
   * as a message with no text and no media, which renders as a blank line.
   *
   * The link is a public instagram.com permalink rather than a signed CDN URL,
   * so unlike everything else here it does not expire.
   */
  for (const share of shares) {
    if (share.link) translated.push({ type: 'share', payload: { url: share.link } });
  }

  for (const attachment of attachments) {
    if (attachment.image_data?.url) {
      translated.push({ type: 'image', payload: { url: attachment.image_data.url } });
      continue;
    }
    if (attachment.video_data?.url) {
      translated.push({ type: 'video', payload: { url: attachment.video_data.url } });
      continue;
    }
    if (attachment.file_url) {
      // `file` covers documents and voice notes; the mime type on the row is
      // what tells them apart, and the normalizer keeps it.
      translated.push({ type: 'file', payload: { url: attachment.file_url } });
    }
    // An attachment with no link at all is dropped: there is nothing to store
    // and nothing to show, and a row with a null url would only look broken.
  }

  return translated;
}

/**
 * The kinds this worker can actually walk. Anything else is paused rather than
 * silently routed to the wrong walk.
 */
const IMPLEMENTED_JOB_KINDS: ReadonlySet<SyncJobKind> = new Set([
  SyncJobKind.BackfillPosts,
  SyncJobKind.BackfillComments,
  SyncJobKind.BackfillConversations,
  SyncJobKind.ResyncConversation,
  SyncJobKind.BackfillMentions,
  SyncJobKind.RefreshProfile,
  SyncJobKind.RefreshPostMetrics,
]);

/** The kinds that read the conversations edge. */
const CONVERSATION_KINDS: ReadonlySet<SyncJobKind> = new Set([
  SyncJobKind.BackfillConversations,
  SyncJobKind.ResyncConversation,
]);

interface ClaimedSyncJob {
  readonly id: number;
  readonly enterpriseId: number;
  readonly channelId: number;
  readonly jobKind: SyncJobKind;
  /** Set for a resync: whose thread this job is about. */
  readonly targetPlatformId: string | null;
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
    private readonly customers: CustomerRepository,
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
    const channel = await this.channels.findBackfillContext(job.enterpriseId, job.channelId);

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
     * Only these two kinds are implemented. The dispatch would otherwise fall
     * through to the comment walk for ANY kind, so backfill_posts would quietly
     * re-copy comments under a job claiming to be about posts.
     */
    if (!IMPLEMENTED_JOB_KINDS.has(job.jobKind)) {
      await this.syncJobs.markPaused(
        job.id,
        this.leaseOwner,
        `sync kind "${job.jobKind}" is not implemented yet`,
      );
      return;
    }

    /*
     * Instagram threads are read through the linked Page, so an Instagram
     * channel with no parent cannot be walked at all.
     */
    if (channel.platform === Platform.Instagram && !channel.parentPlatformChannelId) {
      await this.syncJobs.markPaused(
        job.id,
        this.leaseOwner,
        'the instagram channel is not linked to a facebook page',
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
      /*
       * A profile refresh is one call, not a walk: there is no cursor and
       * nothing to page, so it settles immediately rather than going through
       * the slice machinery.
       */
      if (job.jobKind === SyncJobKind.RefreshProfile) {
        await this.refreshProfile(job, channel, token);
        await this.syncJobs.markCompleted(job.id, this.leaseOwner, 1);
        return;
      }

      const result = await this.walk(job, channel, token, correlationId, leaseSeconds);

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
    channel: ChannelBackfillContext,
    token: string,
    correlationId: string,
    leaseSeconds: number,
  ): Promise<SliceResult> {
    let cursor = job.pageCursor;
    let itemsAdded = 0;

    for (let page = 0; page < SYNC_MAX_PAGES_PER_RUN; page += 1) {
      const slice = await this.page(job, channel, token, correlationId, cursor);

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

  /**
   * Routes to the right walk. Platform first, then kind — the two vocabularies
   * share nothing but the concept, so there is no shared edge to fall back to.
   */
  private async page(
    job: ClaimedSyncJob,
    channel: ChannelBackfillContext,
    token: string,
    correlationId: string,
    cursor: string | null,
  ): Promise<SliceResult> {
    const posts =
      job.jobKind === SyncJobKind.BackfillPosts || job.jobKind === SyncJobKind.RefreshPostMetrics;

    if (channel.platform === Platform.Instagram) {
      // Guarded when the job was claimed.
      const pageId = channel.parentPlatformChannelId as string;
      if (job.jobKind === SyncJobKind.BackfillMentions) {
        return this.instagramTagPage(job, channel.platformChannelId, token, correlationId, cursor);
      }
      if (CONVERSATION_KINDS.has(job.jobKind)) {
        return this.instagramConversationPage(
          job,
          channel.platformChannelId,
          pageId,
          token,
          correlationId,
          cursor,
        );
      }
      return this.instagramMediaPage(
        job,
        channel.platformChannelId,
        token,
        correlationId,
        cursor,
        posts,
      );
    }

    if (CONVERSATION_KINDS.has(job.jobKind)) {
      return this.conversationPage(job, channel.platformChannelId, token, correlationId, cursor);
    }
    if (job.jobKind === SyncJobKind.BackfillMentions) {
      /*
       * Facebook mentions arrive on the `feed` webhook and have no separate read
       * edge to walk — there is no `{pageId}/tags`. Reported as finished with
       * nothing added rather than paused: nothing is wrong, and pausing would
       * hold the live slot for a channel whose other syncs are fine.
       */
      return { itemsAdded: 0, nextCursor: null, finished: true };
    }
    return this.commentPage(job, channel.platformChannelId, token, correlationId, cursor, posts);
  }

  /**
   * One page of Instagram tags: posts by OTHER people that named this account.
   *
   * Emitted as Mention events through the same ledger as everything else, so the
   * existing projector resolves the person, opens the thread and stores the
   * message. The tagger is identified by HANDLE — the tags edge offers no id at
   * all — and the normalizer marks it as a handle so it is never confused with
   * the IGSID a later comment from the same person will carry.
   */
  private async instagramTagPage(
    job: ClaimedSyncJob,
    instagramUserId: string,
    token: string,
    correlationId: string,
    cursor: string | null,
  ): Promise<SliceResult> {
    const edge = await this.graph.listInstagramTags(instagramUserId, token, cursor ?? undefined);

    let added = 0;
    for (const tag of edge.data ?? []) {
      if (!tag.id || !tag.username) continue;

      const payload = {
        field: 'mentions',
        value: {
          media_id: tag.id,
          username: tag.username,
          caption: tag.caption,
          permalink: tag.permalink,
          timestamp: tag.timestamp,
        },
      };

      const result = await this.inbound.insertIgnoringDuplicate({
        enterpriseId: job.enterpriseId,
        channelId: job.channelId,
        sourceKind: SourceKind.Channel,
        sourceId: instagramUserId,
        platform: Platform.Instagram,
        eventType: InboundEventType.Mention,
        platformEventId: tag.id,
        dedupKey: inboundDedupKey(Platform.Instagram, InboundEventType.Mention, tag.id),
        correlationId,
        payload,
        // The platform's own timestamp, not now: this is history, and the
        // ledger's receivedAt is what orders it against everything else.
        receivedAt: tag.timestamp ? new Date(tag.timestamp) : new Date(),
        priority: EventPriority.Low,
      });
      if (result.id !== null) added += 1;
    }

    return {
      itemsAdded: added,
      nextCursor: edge.paging?.cursors?.after ?? null,
      finished: !edge.paging?.next,
    };
  }

  /** One page of Instagram media, emitting a ledger row per comment found. */
  private async instagramMediaPage(
    job: ClaimedSyncJob,
    instagramUserId: string,
    token: string,
    correlationId: string,
    cursor: string | null,
    postsOnly = false,
  ): Promise<SliceResult> {
    const edge = await this.graph.listInstagramMedia(instagramUserId, token, cursor ?? undefined);

    let added = 0;
    for (const media of edge.data ?? []) {
      if (postsOnly) {
        const stored = await this.appendPost(job, correlationId, Platform.Instagram, {
          postId: media.id,
          caption: media.caption ?? null,
          permalink: media.permalink ?? null,
          publishedAt: media.timestamp ?? null,
          kind: media.media_type ?? null,
          commentCount: media.comments_count ?? null,
          likeCount: media.like_count ?? null,
          // Instagram exposes no share count on the media edge.
          shareCount: null,
          media: instagramMedia(media),
        });
        if (stored) added += 1;
        continue;
      }

      const comments = media.comments?.data ?? [];

      // No silent caps: a media item with more comments than one nested page
      // holds is reported, because the remainder is NOT copied by this walk.
      if (comments.length >= SYNC_COMMENTS_PER_POST) {
        this.logger.warn(
          { mediaId: media.id, copied: comments.length, channelId: job.channelId },
          'media has more comments than one nested page — the remainder is not backfilled',
        );
      }

      for (const comment of comments) {
        if (await this.appendInstagramComment(job, media, comment, correlationId)) added += 1;
      }
    }

    return {
      itemsAdded: added,
      nextCursor: edge.paging?.cursors?.after ?? null,
      finished: !edge.paging?.next,
    };
  }

  private async appendInstagramComment(
    job: ClaimedSyncJob,
    media: GraphInstagramMedia,
    comment: GraphInstagramComment,
    correlationId: string,
  ): Promise<boolean> {
    if (!comment.id) return false;

    /*
     * Instagram's OWN webhook shape, so the normaliser has exactly one Instagram
     * shape to understand rather than one per source. `media.id` stands in for
     * the post, which is what the webhook sends too.
     */
    const payload = {
      field: 'comments',
      value: {
        id: comment.id,
        text: comment.text,
        timestamp: comment.timestamp,
        parent_id: comment.parent_id,
        media: { id: media.id },
        from: comment.from,
        username: comment.username,
      },
    };

    const result = await this.inbound.insertIgnoringDuplicate({
      enterpriseId: job.enterpriseId,
      channelId: job.channelId,
      sourceKind: SourceKind.Channel,
      sourceId: media.id,
      platform: Platform.Instagram,
      eventType: InboundEventType.Comment,
      platformEventId: comment.id,
      // Instagram comment webhooks carry no verb, so the key is the id alone —
      // matching composeDedupKey's id-only branch for this platform.
      dedupKey: inboundDedupKey(Platform.Instagram, InboundEventType.Comment, comment.id),
      correlationId,
      payload,
      priority: EventPriority.Low,
      receivedAt: parseTimestamp(comment.timestamp),
    });

    return !result.duplicate;
  }

  /** One page of Instagram message threads, read through the linked Page. */
  private async instagramConversationPage(
    job: ClaimedSyncJob,
    instagramUserId: string,
    pageId: string,
    token: string,
    correlationId: string,
    cursor: string | null,
  ): Promise<SliceResult> {
    const edge = await this.graph.listInstagramConversations(
      pageId,
      token,
      cursor ?? undefined,
      job.targetPlatformId ?? undefined,
    );

    let added = 0;
    for (const conversation of edge.data ?? []) {
      // The Instagram ACCOUNT is the recipient of an Instagram DM, not the Page.
      added += await this.emitMessages(
        job,
        conversation,
        correlationId,
        Platform.Instagram,
        instagramUserId,
      );
    }

    /*
     * Only for a TARGETED job. The profile is one call per person, which is
     * right for a repair about one customer and wrong for a walk of an account
     * with hundreds — that would turn a single backfill into hundreds of
     * rate-limited requests for data nobody asked for.
     */
    if (job.targetPlatformId) {
      await this.applyCustomerProfile(job, job.targetPlatformId, token);
    }

    return this.conversationSlice(job, edge, added);
  }

  /**
   * Fills in who this customer actually is: their picture, their real display
   * name, and whether they follow the business.
   *
   * The conversations edge gives an id and a handle and nothing else, so
   * without this a customer has no avatar at all and is labelled by their
   * handle rather than their name.
   *
   * IT NEVER FAILS THE JOB. Recovering the messages is the point; a profile is
   * an improvement on top, and letting a 400 here undo a repair that already
   * worked would trade something that matters for something that does not.
   */
  private async applyCustomerProfile(
    job: ClaimedSyncJob,
    scopedId: string,
    token: string,
  ): Promise<void> {
    try {
      const customerId = await this.customers.findIdByIdentifier({
        enterpriseId: job.enterpriseId,
        identifierKind: IdentifierKind.InstagramUserId,
        identifierValue: scopedId,
      });
      /*
       * Nothing to attach it to yet: a resync can run before the projector has
       * read the events it just emitted. The participants edge still supplies a
       * name through those events, so nothing is lost — only the picture waits
       * for the next resync.
       */
      if (customerId === null) return;

      const profile = await this.graph.getInstagramUserProfile(scopedId, token);

      /*
       * NOT SPLIT INTO first/last. An Instagram account name belongs to a
       * person or to a business and the API does not say which — "Lokhande's
       * Masala House" became first_name "Lokhande's", last_name "Masala House",
       * which is not a name anybody has. The display name is the whole truth
       * here; first_name stays for sources that genuinely give one, like a
       * Facebook profile.
       */
      const applied = await this.customers.applyPlatformProfile({
        enterpriseId: job.enterpriseId,
        customerId,
        displayName: profile.name ?? profile.username ?? null,
        firstName: null,
        lastName: null,
        avatarUrl: profile.profile_pic ?? null,
        profile: {
          ...(profile.follower_count === undefined
            ? {}
            : { followerCount: profile.follower_count }),
          ...(profile.is_verified_user === undefined
            ? {}
            : { isVerified: profile.is_verified_user }),
          ...(profile.is_user_follow_business === undefined
            ? {}
            : { followsUs: profile.is_user_follow_business }),
          ...(profile.is_business_follow_user === undefined
            ? {}
            : { weFollowThem: profile.is_business_follow_user }),
          // The picture link expires after a few days; this says how old it is.
          ...(profile.profile_pic ? { profileFetchedAt: new Date().toISOString() } : {}),
        },
      });

      this.logger.debug(
        { channelId: job.channelId, applied },
        'customer profile applied from the platform',
      );
    } catch (error) {
      this.logger.warn(
        { channelId: job.channelId, error: (error as Error).message },
        'could not read the customer profile — the messages were still recovered',
      );
    }
  }

  /**
   * Where a conversation walk goes next.
   *
   * A TARGETED job is finished after one page, always. Meta returns at most one
   * conversation for a `user_id` and only its 20 most recent messages, so there
   * is no second page to fetch — and following `paging.next` if the edge
   * offered one would quietly turn a one-thread repair back into a walk of the
   * whole account, which is the cost this job exists to avoid.
   */
  private conversationSlice(
    job: ClaimedSyncJob,
    edge: GraphEdge<GraphConversation>,
    added: number,
  ): SliceResult {
    if (job.targetPlatformId !== null) {
      return { itemsAdded: added, nextCursor: null, finished: true };
    }

    return {
      itemsAdded: added,
      nextCursor: edge.paging?.cursors?.after ?? null,
      finished: !edge.paging?.next,
    };
  }

  /** One page of the feed, emitting a ledger row per comment found. */
  private async commentPage(
    job: ClaimedSyncJob,
    pageId: string,
    token: string,
    correlationId: string,
    cursor: string | null,
    postsOnly = false,
  ): Promise<SliceResult> {
    /*
     * The comments edge is only requested when comments are wanted. That is not
     * an optimisation: nested comments require pages_read_user_content, so
     * asking for them would make a POSTS backfill fail on a permission it does
     * not need.
     */
    const edge = await this.graph.listPagePosts(pageId, token, {
      ...(cursor === null ? {} : { after: cursor }),
      withComments: !postsOnly,
    });

    let added = 0;
    for (const post of edge.data ?? []) {
      added += postsOnly
        ? Number(
            await this.appendPost(job, correlationId, Platform.Facebook, {
              postId: post.id,
              caption: post.message ?? post.story ?? null,
              permalink: post.permalink_url ?? null,
              publishedAt: post.created_time ?? null,
              kind: post.status_type ?? null,
              /*
               * The PLATFORM's counts, each of which had to be asked for by name
               * in listPagePosts. They were all null here, so posts.like_count
               * and posts.share_count stayed at zero for every Facebook post the
               * service had ever synced.
               */
              commentCount: post.comment_summary?.summary?.total_count ?? null,
              likeCount: post.reactions?.summary?.total_count ?? null,
              shareCount: post.shares?.count ?? null,
              media: facebookMedia(post),
            }),
          )
        : await this.emitComments(job, post, correlationId);
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
    const edge = await this.graph.listPageConversations(
      pageId,
      token,
      cursor ?? undefined,
      job.targetPlatformId ?? undefined,
    );

    let added = 0;
    for (const conversation of edge.data ?? []) {
      added += await this.emitMessages(job, conversation, correlationId, Platform.Facebook, pageId);
    }

    return this.conversationSlice(job, edge, added);
  }

  private async emitMessages(
    job: ClaimedSyncJob,
    conversation: GraphConversation,
    correlationId: string,
    platform: Platform,
    selfPlatformId: string,
  ): Promise<number> {
    let added = 0;

    /*
     * Names live on the THREAD, not on its messages: the participants edge is
     * the only place Meta gives one, and a message carries just an id. Built
     * once per thread rather than per message.
     */
    const namesById = new Map<string, string>();
    /*
     * Handles are carried on the EVENT for the same reason names are, and it
     * took a lost DM to notice they were not. The linking below only fires for a
     * customer that already exists — but on a resync the customer is created
     * afterwards, by the projector reading these events. So on first contact the
     * handle was resolved, used for the display name, and then dropped, and the
     * person could never be found by the name they are actually known as.
     */
    const handlesById = new Map<string, string>();
    for (const participant of conversation.participants?.data ?? []) {
      /*
       * A NAME and a HANDLE are different things and only one of them splits.
       * Facebook returns a person's name, Instagram a handle; the display name
       * falls back to whichever exists, but only a real name is decomposed.
       */
      const personName = participant.name ?? null;
      const handle = participant.username ?? null;
      const name = personName ?? handle;
      if (!participant.id || !name) continue;
      namesById.set(participant.id, name);
      if (handle) handlesById.set(participant.id, handle);

      /*
       * Written straight to the customer, not left to the message projection.
       * A second walk of a thread inserts no new events — dedup — so a name
       * carried only on an event never reaches a customer who already exists.
       * This runs on every walk and fills gaps without overwriting.
       */
      if (participant.id === selfPlatformId) continue;
      const split = splitPersonName(personName);
      const named = await this.customers.nameByIdentifier({
        enterpriseId: job.enterpriseId,
        identifierKind:
          platform === Platform.Instagram
            ? IdentifierKind.InstagramUserId
            : IdentifierKind.FacebookUserId,
        identifierValue: participant.id,
        displayName: name,
        firstName: split.firstName,
        lastName: split.lastName,
      });
      if (named) {
        // No name in the log: it identifies a person.
        this.logger.info(
          { channelId: job.channelId, platform },
          'named a customer from the conversation participants',
        );
      }

      /*
       * An Instagram handle is a SECOND IDENTIFIER, not just a label: it is how
       * a person is addressed and searched for, and it belongs in
       * customer_identifiers next to the numeric id rather than only inside
       * display_name. Facebook exposes no handle on this edge.
       */
      if (platform === Platform.Instagram && handle) {
        const customerId = await this.customers.findIdByIdentifier({
          enterpriseId: job.enterpriseId,
          identifierKind: IdentifierKind.InstagramUserId,
          identifierValue: participant.id,
        });
        if (customerId !== null) {
          await this.customers.linkIdentifier({
            enterpriseId: job.enterpriseId,
            customerId,
            identifierKind: IdentifierKind.InstagramUsername,
            identifierValue: handle,
          });
        }
      }
    }

    /*
     * OLDEST FIRST. Graph returns a thread newest-first, and projecting in that
     * order means every reply is stored before the message it answers, and the
     * row ids of a recovered thread run backwards against time. Reversing costs
     * nothing on a page of twenty and makes the common case resolve on the way
     * in rather than by adoption afterwards.
     */
    const messages = [...(conversation.messages?.data ?? [])].reverse();

    /*
     * NO SILENT CAPS. Graph nests message paging inside conversation paging, and
     * this walk reads only the first nested page — so a thread with more than
     * SYNC_MESSAGES_PER_CONVERSATION messages is TRUNCATED, and nothing said so.
     * The comment walk already reports its own truncation; this one did not, so
     * a long thread simply arrived incomplete and looked finished.
     */
    if (messages.length >= SYNC_MESSAGES_PER_CONVERSATION) {
      this.logger.warn(
        {
          conversationId: conversation.id,
          copied: messages.length,
          channelId: job.channelId,
        },
        'thread has more messages than one nested page — the remainder is not backfilled',
      );
    }

    for (const message of messages) {
      if (!message.id) continue;

      const senderId = message.from?.id ?? null;
      /*
       * is_echo is DERIVED here, and it matters: a thread contains the Page's
       * own replies as well as the customer's messages. The projector already
       * skips echoes, so marking them keeps the Page from being projected as a
       * customer of itself.
       */
      const isEcho = senderId !== null && senderId === selfPlatformId;

      /*
       * `sender.name` is an ADDITION to Meta's webhook shape, not a change to
       * it: a real messaging webhook has no name, so the projector treats it as
       * optional and falls back to null exactly as before. This is the only way
       * a backfilled customer gets a name at all.
       */
      const senderName =
        senderId !== null && !isEcho
          ? (namesById.get(senderId) ?? message.from?.name ?? null)
          : null;

      /*
       * Translated into the WEBHOOK's attachment shape, not stored in the read
       * edge's own. The projector already knows how to read a webhook, so a
       * message recovered by a resync ends up identical to the same message
       * delivered live — one normalizer, one set of rules, no second place for
       * story mentions and GIFs to be classified differently.
       */
      const attachments = toWebhookAttachments(
        message.attachments?.data ?? [],
        message.shares?.data ?? [],
      );

      const senderHandle =
        senderId !== null && !isEcho ? (handlesById.get(senderId) ?? null) : null;

      const payload = {
        sender: {
          id: senderId ?? undefined,
          ...(senderName ? { name: senderName } : {}),
          // Instagram only; Facebook's participants edge exposes no handle.
          ...(senderHandle ? { username: senderHandle } : {}),
        },
        recipient: { id: selfPlatformId },
        /*
         * Marks this as RECONSTRUCTED rather than delivered. It matters for one
         * decision: a live echo of our own message must be ignored, because the
         * reply flow already wrote that row — but a recovered one is the only
         * copy that will ever exist, since a reply typed in the Instagram app
         * was never recorded here at all.
         */
        recovered: true,
        timestamp: toUnixMilliseconds(message.created_time),
        message: {
          mid: message.id,
          text: message.message,
          is_echo: isEcho,
          ...(attachments.length > 0 ? { attachments } : {}),
          // Passed through unchanged: the projector reads the webhook shape,
          // and this edge happens to use the same one.
          ...(message.reply_to?.mid ? { reply_to: message.reply_to } : {}),
        },
      };

      const result = await this.inbound.insertIgnoringDuplicate({
        enterpriseId: job.enterpriseId,
        channelId: job.channelId,
        sourceKind: SourceKind.Channel,
        sourceId: conversation.id,
        platform,
        eventType: InboundEventType.DirectMessage,
        platformEventId: message.id,
        // Messages carry no verb, matching composeDedupKey's id-only branch.
        dedupKey: inboundDedupKey(platform, InboundEventType.DirectMessage, message.id),
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
   * Re-reads a channel's profile: its name, handle and follower count.
   *
   * Nothing else refreshes these. Without it a Page renamed after connecting
   * keeps its old name in the product forever, and the follower count stays at
   * the zero it was created with.
   */
  private async refreshProfile(
    job: ClaimedSyncJob,
    channel: ChannelBackfillContext,
    token: string,
  ): Promise<void> {
    const profile = await this.graph.getChannelProfile(
      channel.platformChannelId,
      token,
      channel.platform,
    );

    await this.channels.updateProfile({
      enterpriseId: job.enterpriseId,
      channelId: job.channelId,
      name: profile.name ?? profile.username ?? null,
      username: profile.username ?? null,
      // A Page reports fan_count, an Instagram account followers_count.
      followerCount: profile.followers_count ?? profile.fan_count ?? null,
      profilePictureUrl: profile.profile_picture_url ?? null,
    });

    this.logger.info(
      { channelId: job.channelId, platform: channel.platform },
      'channel profile refreshed',
    );
  }

  /**
   * Appends a post_update event in ONE canonical shape.
   *
   * The two platforms name everything differently — message vs caption,
   * created_time vs timestamp, status_type vs media_type — so the mapping
   * happens here, once, and the projector receives a single shape. The
   * alternative is two projectors that drift.
   */
  private async appendPost(
    job: ClaimedSyncJob,
    correlationId: string,
    platform: Platform,
    post: {
      postId: string;
      caption: string | null;
      permalink: string | null;
      publishedAt: string | null;
      kind: string | null;
      commentCount: number | null;
      likeCount: number | null;
      shareCount: number | null;
      media: { url?: string; thumbnailUrl?: string; type?: string } | null;
    },
  ): Promise<boolean> {
    if (!post.postId) return false;

    const payload = {
      field: 'posts',
      value: {
        post_id: post.postId,
        caption: post.caption,
        permalink_url: post.permalink,
        published_at: post.publishedAt,
        post_kind: post.kind,
        comment_count: post.commentCount,
        like_count: post.likeCount,
        share_count: post.shareCount,
        media: post.media,
      },
    };

    const result = await this.inbound.insertIgnoringDuplicate({
      enterpriseId: job.enterpriseId,
      channelId: job.channelId,
      sourceKind: SourceKind.Channel,
      sourceId: post.postId,
      platform,
      eventType: InboundEventType.PostUpdate,
      platformEventId: post.postId,
      /*
       * A REFRESH needs a new key or nothing happens. The backfill key is the
       * post id alone, which is right — a post is copied once — but it means a
       * second walk inserts nothing, the projector never runs, and captions and
       * counts can never be updated. A refresh therefore scopes its key to the
       * day, so it refreshes once per day per post rather than never.
       */
      dedupKey: inboundDedupKey(
        platform,
        InboundEventType.PostUpdate,
        job.jobKind === SyncJobKind.RefreshPostMetrics
          ? `${post.postId}:${new Date().toISOString().slice(0, 10)}`
          : post.postId,
      ),
      correlationId,
      payload,
      priority: EventPriority.Low,
      receivedAt: parseTimestamp(post.publishedAt ?? undefined),
    });

    return !result.duplicate;
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

/**
 * Facebook's preview image.
 *
 * `full_picture` is what the platform itself renders, so it is preferred; the
 * attachment's image is a fallback for posts that have one without the other.
 */
function facebookMedia(post: GraphFeedPost): { url?: string; type?: string } | null {
  const attachment = post.attachments?.data?.[0];
  const url = post.full_picture ?? attachment?.media?.image?.src;
  if (!url) return null;
  return { url, ...(attachment?.type ? { type: attachment.type } : {}) };
}

/**
 * Instagram's preview.
 *
 * thumbnail_url exists only for video, where media_url is the video file — using
 * media_url for everything would put a playable video where a thumbnail belongs.
 */
function instagramMedia(
  media: GraphInstagramMedia,
): { url?: string; thumbnailUrl?: string; type?: string } | null {
  const url = media.thumbnail_url ?? media.media_url;
  if (!url) return null;
  return {
    url,
    ...(media.thumbnail_url ? { thumbnailUrl: media.thumbnail_url } : {}),
    ...(media.media_type ? { type: media.media_type } : {}),
  };
}
