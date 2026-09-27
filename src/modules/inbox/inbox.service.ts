import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import {
  ConversationRepository,
  type ConversationRow,
} from '@/database/repositories/conversation.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { EnterpriseEmployeeRepository } from '@/database/repositories/enterprise-employee.repository';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import { TokenCipherService } from '@/shared/crypto/token-cipher.service';
import {
  MessageAttachmentRepository,
  type AttachmentRow,
} from '@/database/repositories/message-attachment.repository';
import { MessageRepository, type MessageRow } from '@/database/repositories/message.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import { TransactionManager } from '@/database/transaction';
import { RequestContext } from '@/shared/context';
import {
  permissionFor,
  visibleKinds,
  type ConversationAction,
} from '@/shared/rbac';
import { clampLimit } from '@/shared/utils/page-limit';
import { isExpiringMediaUrl, toWebhookAttachments } from './attachment-normalizer';
import {
  BACKGROUND_PLATFORM_TIMEOUT_MS,
  CUSTOMER_AVATAR_TTL_MS,
  READ_PATH_PLATFORM_BUDGET_MS,
  MENTION_MEDIA_TTL_MS,
} from '@/shared/constants';
import {
  AuditAction,
  AuditEntityType,
  ConversationKind,
  Permission,
  MessageDirection,
  ConversationStatus,
  Platform,
  DestinationKind,
  MessageKind,
  MessageStatus,
  OutboundEventType,
  SyncJobKind,
  SyncTriggerKind,
} from '@/shared/enums';
import { AuditService } from '@/modules/audit';
import { AppException, ErrorCode } from '@/shared/errors';
import { decodeKeysetCursor, encodeKeysetCursor } from '@/shared/utils/keyset-cursor';
import { outboundDedupKey } from '@/modules/ledger/dedup-key.util';
import { CLOSED_TO_REPLIES, evaluateReplyWindow, replyEventTypeFor } from './reply-window';

/**
 * The kinds the platform can be asked about again.
 *
 * Only message threads: a comment thread has no conversations edge, and a
 * mention has no single participant to scope the request by. StoryReply is a
 * message thread with a different label, so it belongs here.
 */
const RESYNCABLE_KINDS: ReadonlySet<ConversationKind> = new Set([
  ConversationKind.DirectMessage,
]);

export interface ReplyInput {
  readonly conversationRefId: string;
  readonly body: string;
  /** Required: see ReplyRequestSchema for why it is not optional. */
  readonly idempotencyKey: string;
  /** Team-only note: never sent, never touches the ledger. */
  readonly internalNote: boolean;
  /** Answer ONE message in particular, by its ref_id in this conversation. */
  readonly replyToMessageRefId?: string | undefined;
}

export interface ReplyResult {
  readonly messageRefId: string;
  readonly status: MessageStatus;
}

@Injectable()
export class InboxService {
  /**
   * Conversations whose media refresh is already running.
   *
   * Per process, deliberately: this guards against the same agent's repeated
   * opens and a few colleagues looking at once, which is the realistic case. A
   * cross-process guard would be a lock for a call that costs one request.
   */
  private readonly mentionRefreshesInFlight = new Set<number>();

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly attachments: MessageAttachmentRepository,
    private readonly syncJobs: SyncJobRepository,
    private readonly outbound: OutboundEventRepository,
    private readonly channels: ChannelRepository,
    private readonly customers: CustomerRepository,
    private readonly employees: EnterpriseEmployeeRepository,
    private readonly graph: GraphApiClient,
    private readonly cipher: TokenCipherService,
    private readonly audit: AuditService,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(InboxService.name) private readonly logger: PinoLogger,
  ) {}

  async listInbox(
    enterpriseId: number,
    options: {
      status: ConversationStatus | null;
      assignedToEmployeeId: number | null;
      conversationKind: ConversationKind | null;
      limit: number;
      cursor: string | null;
    },
  ): Promise<{ items: ConversationRow[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = clampLimit(options.limit);

    /*
     * ONLY THE KINDS THIS ACTOR MAY SEE.
     *
     * Filtered into the query rather than out of the page, for the reason the
     * employee listing is: dropping rows after the fetch returns a short page
     * while more matching rows exist, and a short page reads as the end of the
     * results — so threads would silently disappear off the end.
     *
     * An explicit `kind` filter is INTERSECTED with this rather than trusted.
     * Asking for a kind you may not see returns nothing, which is the same
     * answer as a business that has none of that kind — and is what stops the
     * filter being a way to probe for what exists.
     */
    const permitted = visibleKinds(RequestContext.actor()?.permissions ?? new Set());
    if (permitted.length === 0) {
      return { items: [], nextCursor: null, hasMore: false };
    }
    const kinds =
      options.conversationKind === null
        ? permitted
        : permitted.filter((kind) => kind === options.conversationKind);
    if (kinds.length === 0) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const rows = await this.conversations.listInbox({
      enterpriseId,
      status: options.status,
      assignedToEmployeeId: options.assignedToEmployeeId,
      conversationKinds: kinds,
      // One extra row is the cheapest way to know whether another page exists,
      // without a second COUNT query over the same predicate.
      limit: limit + 1,
      cursor: decodeInboxCursor(options.cursor),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    return {
      items,
      nextCursor: hasMore && last ? encodeKeysetCursor(last.lastMessageAt, last.id) : null,
      hasMore,
    };
  }

  /**
   * Asks the platform for this one thread again.
   *
   * REPAIR, not history. Meta drops a webhook often enough to matter — on
   * 2026-09-05 a sticker arrived as a `message_edit` for a message id that was
   * never delivered, so the message simply did not exist here — and the
   * conversations edge can be asked for a single participant with `user_id`.
   * The projector dedups on the platform message id, so re-reading a thread we
   * already have is a no-op rather than a duplicate.
   *
   * It is deliberately not the channel-wide backfill: that walks every
   * conversation the business has, holds the channel's one live slot for the
   * kind, and is meant to run once at connect.
   *
   * Meta serves only the 20 most recent messages of a thread, so this recovers a
   * recent gap and cannot reach further back.
   */
  async requestResync(
    enterpriseId: number,
    conversationRefId: string,
  ): Promise<{ queued: boolean }> {
    const target = await this.conversations.findResyncTarget(enterpriseId, conversationRefId);
    if (!target) throw new AppException(ErrorCode.ConversationNotFound);

    /*
     * Only a message thread. A comment thread is not a conversation as far as
     * the platform is concerned — it has no conversations edge — and a mention
     * has no participant to scope by.
     */
    if (!RESYNCABLE_KINDS.has(target.conversationKind)) {
      throw new AppException(ErrorCode.ConversationResyncUnsupported);
    }
    // No identifier means nothing to pass as user_id, so the walk would silently
    // widen to the whole account.
    if (!target.targetPlatformId) {
      throw new AppException(ErrorCode.ConversationResyncUnsupported);
    }

    /*
     * `queued: false` is a SUCCESS: a resync for this thread is already waiting
     * or running, and a second one would do the same work twice. It is what
     * makes the endpoint safe to call from a button somebody can double-click.
     */
    const queued = await this.syncJobs.enqueueIfAbsent({
      enterpriseId,
      channelId: target.channelId,
      jobKind: SyncJobKind.ResyncConversation,
      triggerKind: SyncTriggerKind.Manual,
      targetPlatformId: target.targetPlatformId,
    });

    this.logger.info(
      { enterpriseId, conversationRefId, queued },
      queued ? 'conversation resync queued' : 'a resync for this thread is already in flight',
    );
    return { queued };
  }

  async readThread(
    enterpriseId: number,
    conversationRefId: string,
    limit: number,
    cursor: string | null,
    beforeId: number | null,
  ): Promise<{
    conversation: ConversationRow;
    messages: MessageRow[];
    attachmentsByMessageId: ReadonlyMap<number, AttachmentRow[]>;
    /**
     * Who wrote the comments in a mention's surrounding thread, for the ones we
     * already hold. Meta returns that thread anonymous; this is what we can
     * recover from our own records.
     */
    knownAuthors: ReadonlyMap<string, { authorName: string | null; direction: MessageDirection }>;
    /**
     * The mention this one was replying to, when that comment tagged us too and
     * is therefore already a conversation of ours. Null in the ordinary case.
     */
    parentMention: { refId: string; subject: string | null } | null;
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const size = clampLimit(limit);

    /*
     * Before anything is read from it. A mention's media links expire, and this
     * hands back the row with fresh ones when they were due — see
     * withFreshMentionMedia for why that happens on read rather than on a timer.
     */
    const conversation = await this.withFreshCustomerAvatar(
      enterpriseId,
      await this.requireConversation(enterpriseId, conversationRefId, 'view'),
    );

    /*
     * NOT AWAITED, and that is the whole design — see the method.
     * Measured at 3.1–4.8s against the live API, so waiting for it would make
     * every stale mention a five-second open.
     */
    this.refreshMentionMediaInBackground(enterpriseId, conversation);

    /*
     * beforeId is the DEPRECATED form of this cursor and is translated rather
     * than used directly. A bare id cannot page this list correctly: the thread
     * is ordered on COALESCE(platform_sent_at, created_at) and ids are assigned
     * at insert time, which the backfill worker breaks by appending years-old
     * messages after today's — so `id < n` both hides messages and repeats
     * others. Translating it to the real sort key keeps old callers correct.
     */
    const keyset =
      decodeThreadCursor(cursor) ??
      (beforeId === null
        ? null
        : await this.messages.findThreadPosition(enterpriseId, conversation.id, beforeId));

    const rows = await this.messages.listThread(enterpriseId, conversation.id, size + 1, keyset);
    const hasMore = rows.length > size;
    const messages = hasMore ? rows.slice(0, size) : rows;
    const last = messages[messages.length - 1];

    /*
     * ONE query for the whole page's media, not one per message. Only messages
     * that claim attachments are asked about, so a thread of plain text costs
     * nothing at all.
     */
    const withMedia = messages.filter((message) => message.hasAttachments).map((m) => m.id);
    const attachmentRows = await this.attachments.listForMessages(enterpriseId, withMedia);

    const attachmentsByMessageId = new Map<number, AttachmentRow[]>();
    for (const row of attachmentRows) {
      const existing = attachmentsByMessageId.get(row.messageId);
      if (existing) existing.push(row);
      else attachmentsByMessageId.set(row.messageId, [row]);
    }

    /*
     * PUT THE NAMES BACK ON A MENTION'S THREAD.
     *
     * Meta returns the comments around a mention with the author omitted on
     * every one (docs/platform-limitations.md §1.4) — but several of them are
     * OURS: replies this business sent, and earlier mentions already stored
     * here. Rendering those as "someone" told an agent we did not know who said
     * something we said ourselves.
     *
     * One query for the whole thread, and only when there is a thread to name.
     */
    const knownAuthors = await this.messages.findKnownAuthors(
      enterpriseId,
      threadCommentIds(conversation.contextMetadata ?? {}),
    );

    /*
     * THE SAME EXCHANGE, FILED TWICE. A tag inside a reply to another tag gives
     * us two conversations for one thread, and we already stored both halves of
     * the link — the child's `mentionParentId` and the parent's
     * `mentionedCommentId` are the same comment id. Nothing derived it, so an
     * agent saw the parent's text duplicated into the child with no way to
     * reach the conversation it belongs to.
     *
     * Only asked when the mention actually has a parent, so an ordinary
     * top-level mention costs no query.
     */
    const parentCommentId = conversation.contextMetadata?.mentionParentId;
    const parentMention =
      typeof parentCommentId === 'string'
        ? await this.conversations.findMentionByCommentId(enterpriseId, parentCommentId)
        : null;

    return {
      conversation,
      messages,
      attachmentsByMessageId,
      knownAuthors,
      parentMention,
      nextCursor:
        hasMore && last ? encodeKeysetCursor(last.platformSentAt ?? last.createdAt, last.id) : null,
      hasMore,
    };
  }

  /**
   * Re-resolves a mention's media links when they are old enough to be at risk.
   *
   * WHY THIS IS NEEDED AT ALL. Instagram serves media from signed CDN links
   * that expire — the expiry is the `oe=` parameter in the link itself — and a
   * mention is resolved exactly once, when it arrives. Measured on live data, a
   * reel's `media_url` lasted about 35 hours. So a mention opened two days
   * later showed a broken image, on a post that was perfectly fine, with
   * nothing to say why.
   *
   * ON READ RATHER THAN ON A TIMER, because the alternative is refreshing
   * millions of links nobody will look at. A thread nobody opens costs nothing;
   * one that is opened pays at most one Graph call per six hours.
   *
   * A FAILURE HERE MUST NOT FAIL THE READ. The same rule the projector follows:
   * this is enrichment, and a mention with stale links is far better than a
   * thread that will not open because Meta is slow. Every failure path below
   * leaves the stored answer in place and returns.
   */
  private refreshMentionMediaInBackground(
    enterpriseId: number,
    conversation: ConversationRow,
  ): void {
    if (conversation.conversationKind !== ConversationKind.Mention) return;

    const metadata = conversation.contextMetadata ?? {};
    const mediaId = typeof metadata.mentionedMediaId === 'string' ? metadata.mentionedMediaId : null;
    if (!mediaId) return;

    const refreshedAt =
      typeof metadata.postDetailsRefreshedAt === 'string'
        ? Date.parse(metadata.postDetailsRefreshedAt)
        : Number.NaN;
    // NaN fails this comparison, which is the wanted answer for a conversation
    // resolved before the stamp existed: refresh it once, then it has one.
    if (Date.now() - refreshedAt < MENTION_MEDIA_TTL_MS) return;

    /*
     * ONE CALL PER CONVERSATION AT A TIME. Ten agents opening the same mention
     * is ten opens of one thread, not ten reasons to ask Meta the same question
     * — and at four seconds each they would overlap freely.
     */
    if (this.mentionRefreshesInFlight.has(conversation.id)) return;
    this.mentionRefreshesInFlight.add(conversation.id);

    void this.resolveMentionMedia(enterpriseId, conversation, metadata, mediaId).finally(() => {
      this.mentionRefreshesInFlight.delete(conversation.id);
    });
  }

  /** The body of the background refresh. Never throws; never blocks a read. */
  private async resolveMentionMedia(
    enterpriseId: number,
    conversation: ConversationRow,
    metadata: Record<string, unknown>,
    mediaId: string,
  ): Promise<void> {

    const channel = await this.channels.findBackfillContext(enterpriseId, conversation.channelId);
    if (!channel?.effectiveAccessToken || !channel.platformChannelId) return;
    // A channel already known to need re-auth would spend a call to be told so.
    if (channel.reauthRequired) return;

    let token: string;
    try {
      token = this.cipher.decrypt(channel.effectiveAccessToken);
    } catch {
      // Key loss or tampering. The relay and backfill both alert on this.
      return;
    }

    const commentId =
      typeof metadata.mentionedCommentId === 'string' ? metadata.mentionedCommentId : null;

    try {
      /*
       * The full platform timeout, not the read budget: nobody is waiting on
       * this, and the call genuinely takes three to five seconds.
       */
      const resolved = await this.graph.resolveInstagramMention(
        channel.platformChannelId,
        { commentId, mediaId },
        token,
        // Nobody is waiting on this, and one mention in eighteen needs longer
        // than a worker's ceiling — see BACKGROUND_PLATFORM_TIMEOUT_MS.
        BACKGROUND_PLATFORM_TIMEOUT_MS,
      );
      if (!resolved?.media) {
        // Logged, because silence here is what hid a 1.5s budget that could
        // never be met: "Meta said nothing" and "we gave up" looked identical.
        this.logger.debug(
          { enterpriseId, conversationId: conversation.id },
          'the mentions edge described no media; keeping the stored links',
        );
        return;
      }

      /*
       * MERGED, NOT REPLACED, and this is not defensive coding — Meta really
       * does vary what it returns for the same media between calls. Asked for
       * eleven fields on one reel it sent ten and omitted `media_url`, while
       * another reel in the same account returned both (§6.0.1). A wholesale
       * replace would let one such answer delete a link we already had and
       * could still use.
       *
       * So a new value wins only when there IS one. The worst case is keeping a
       * link that has since expired, and the client already falls back from a
       * dead video to the still and then to the permalink — whereas a field we
       * threw away is not recoverable from anywhere.
       */
      const previous =
        typeof metadata.postDetails === 'object' && metadata.postDetails !== null
          ? (metadata.postDetails as Record<string, unknown>)
          : {};
      const merged: Record<string, unknown> = { ...previous };
      for (const [field, value] of Object.entries(resolved.media)) {
        if (value !== null && value !== undefined) merged[field] = value;
      }

      /*
       * EVERYTHING THE CALL RETURNED, not only the media.
       *
       * resolveInstagramMention answers with twelve things and the first
       * version of this stored one. The call is the expensive part — three to
       * five seconds of it — and the rest arrived free in the same response.
       *
       * Two of them genuinely CHANGE between reads and so were frozen at
       * projection time for ever: `replies` under our mention, and
       * `postComments`, the room around it. Meta sends no webhook when somebody
       * replies to a mention (§1.x), which makes a re-read the only way either
       * is ever updated — and this was the re-read.
       *
       * The same keys the projector writes, so one shape reaches the thread
       * whether it came from the webhook or from here. Each is set only when
       * present, so a quieter answer never deletes a fuller one.
       */
      const patch: Record<string, unknown> = {
        postDetails: merged,
        postDetailsRefreshedAt: new Date().toISOString(),
      };
      if (resolved.permalink) patch.postPermalink = resolved.permalink;
      if (resolved.mediaOwnerUsername) patch.postOwnerUsername = resolved.mediaOwnerUsername;
      if (resolved.replies.length > 0) patch.replyThread = resolved.replies;
      if (resolved.parent) patch.mentionParent = resolved.parent;
      if (resolved.parentCommentId) patch.mentionParentId = resolved.parentCommentId;
      // Zero is a real answer and must survive; `if (count)` would drop it and
      // make an unliked mention look like one Meta refused to count.
      if (typeof resolved.likeCount === 'number') patch.mentionLikeCount = resolved.likeCount;
      if (resolved.postComments.length > 0) {
        patch.postComments = resolved.postComments;
        // The snapshot is worthless without saying when it was taken.
        patch.postCommentsReadAt = new Date().toISOString();
      }
      await this.conversations.mergeContextMetadata(enterpriseId, conversation.id, patch);

      this.logger.debug(
        { enterpriseId, conversationId: conversation.id },
        'refreshed a mention\u2019s media links',
      );
    } catch (error) {
      /*
       * Swallowed deliberately: an unreadable mention is ordinary — the post
       * may be deleted, the account gone private, or the quota spent — and
       * nobody is waiting on the answer. Debug rather than warn because this
       * runs whenever a stale mention is opened.
       */
      /*
       * `reason` alongside `err`, because the serialised error came back EMPTY
       * in a bulk run — eighteen refreshes, two failures, and a log line that
       * said only that something went wrong. An error log without the error is
       * an operator reading tea leaves, and the one place that costs most is
       * exactly here, where every failure is swallowed on purpose.
       */
      this.logger.debug(
        {
          err: error,
          reason: error instanceof Error ? error.message : String(error),
          enterpriseId,
          conversationId: conversation.id,
        },
        'could not refresh mention media; the stored links stay',
      );
    }
  }

  /**
   * Re-fetches a customer's profile picture when it is missing or old.
   *
   * TWO PROBLEMS, ONE FIX. Instagram's `profile_pic` is a signed link that
   * lasts four to five days, and nothing ever refreshed it — the one picture in
   * the dev database was taken on 06 Sep and died on 10 Sep. Worse, the picture
   * was only ever fetched during a conversation BACKFILL, so most customers
   * never had one at all: of five customers, one.
   *
   * Refreshing on read fixes both, because "missing" and "stale" take the same
   * branch — a customer with no stamp is due, which is exactly right for one
   * that was never fetched.
   *
   * Same rules as the mention refresh beside it: bounded, and a failure leaves
   * the stored answer alone rather than failing the read.
   */
  private async withFreshCustomerAvatar(
    enterpriseId: number,
    conversation: ConversationRow,
  ): Promise<ConversationRow> {
    if (conversation.platform !== Platform.Instagram) return conversation;

    const target = await this.customers.findAvatarRefreshTarget(
      enterpriseId,
      conversation.customerId,
    );
    if (!target) return conversation;

    const fetchedAt = target.fetchedAt === null ? Number.NaN : Date.parse(target.fetchedAt);
    // NaN fails this, which is what makes a customer who never had a picture due.
    if (Date.now() - fetchedAt < CUSTOMER_AVATAR_TTL_MS) return conversation;

    const channel = await this.channels.findBackfillContext(enterpriseId, conversation.channelId);
    if (!channel?.effectiveAccessToken || channel.reauthRequired) return conversation;

    let token: string;
    try {
      token = this.cipher.decrypt(channel.effectiveAccessToken);
    } catch {
      return conversation;
    }

    try {
      const profile = await withinBudget(
        this.graph.getInstagramUserProfile(target.scopedId, token),
        READ_PATH_PLATFORM_BUDGET_MS,
      );
      if (!profile?.profile_pic) return conversation;

      /*
       * EVERYTHING THE CALL ALREADY RETURNED, not just the picture.
       *
       * This asked for `name,username,profile_pic,follower_count` and the
       * profile edge answers with the follow flags and the verified flag
       * besides — and the first version of this stored the picture and threw
       * the rest away. Two customers ended up with a fresh avatar and no idea
       * whether they follow the business, from a response that said so.
       *
       * The data is already paid for: it arrived in a call we made anyway. The
       * standing rule is to take the most granular thing Meta offers at every
       * opportunity, because a field not captured on arrival usually cannot be
       * captured later (platform-limitations §0.5).
       *
       * Each is spread only when present, so a field Meta omits leaves the
       * stored answer alone rather than overwriting it with undefined — the
       * same merge discipline the mention refresh uses.
       *
       * The display NAME is deliberately left to the backfill. It is the one
       * field here a human might reasonably edit, and a read path rewriting it
       * on every thread open is a different decision from capturing a fact only
       * Meta knows.
       */
      await this.customers.applyPlatformProfile({
        enterpriseId,
        customerId: conversation.customerId,
        displayName: null,
        firstName: null,
        lastName: null,
        avatarUrl: profile.profile_pic,
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
          profileFetchedAt: new Date().toISOString(),
        },
      });

      return { ...conversation, customerAvatarUrl: profile.profile_pic };
    } catch (error) {
      // Ordinary: the account may have gone private, or the quota is spent.
      this.logger.debug(
        { err: error, enterpriseId, customerId: conversation.customerId },
        'could not refresh the customer picture; serving what we have',
      );
      return conversation;
    }
  }

  /**
   * Replaces expired attachment links with fresh ones, for whatever Meta will
   * still describe.
   *
   * DRIVEN BY THE CLIENT, because nothing else can tell. These links live on
   * `lookaside.fbsbx.com` and carry NO expiry parameter — unlike a mention's
   * media, where `oe=` says when it dies. Measured 19 Sep: of five stored on
   * 06 Sep, a HEAD gave 200, 404, 200, 404, 200. Half dead in under a
   * fortnight, with nothing in the URL to predict which half. So the browser,
   * which is the only party that finds out, asks for a refresh.
   *
   * WHAT IT CANNOT DO, and this is the honest limit rather than a bug: Meta's
   * conversations edge returns only the most recent messages of a thread —
   * about twenty. Anything older cannot be re-read, so its media is gone for
   * good. On the dev data every attachment that was actually dead fell outside
   * that window; the threads held 27 and 29 messages and Meta returned 21 and
   * 19. The caller is told how many were beyond reach rather than left to
   * wonder why nothing changed.
   *
   * Never throws for an unreadable thread: a refresh that cannot help is not an
   * error, it is an answer.
   */
  async refreshAttachments(
    enterpriseId: number,
    conversationRefId: string,
  ): Promise<{ refreshed: number; beyondReach: number }> {
    // A refresh replaces a dead media link with a live one and reveals nothing
    // that reading the thread did not already show, so it is a read.
    const conversation = await this.requireConversation(enterpriseId, conversationRefId, 'view');

    const stored = await this.attachments.listRefreshable(enterpriseId, conversation.id);
    if (stored.length === 0) return { refreshed: 0, beyondReach: 0 };

    const channel = await this.channels.findBackfillContext(enterpriseId, conversation.channelId);
    if (!channel?.effectiveAccessToken || channel.reauthRequired) {
      return { refreshed: 0, beyondReach: stored.length };
    }

    let token: string;
    try {
      token = this.cipher.decrypt(channel.effectiveAccessToken);
    } catch {
      return { refreshed: 0, beyondReach: stored.length };
    }

    /*
     * The customer's id, which scopes the read to this one thread. Without it
     * the walk widens to the whole account — the same trap requestResync
     * guards against.
     */
    const participantId = conversation.platformThreadId.replace(/^dm:/, '');
    if (!participantId) return { refreshed: 0, beyondReach: stored.length };

    let fresh: Map<string, { url: string; mimeType: string | null }[]>;
    try {
      fresh = await this.readFreshAttachmentLinks(conversation, channel, token, participantId);
    } catch (error) {
      this.logger.debug(
        { err: error, enterpriseId, conversationId: conversation.id },
        'could not re-read the thread for fresh attachment links',
      );
      return { refreshed: 0, beyondReach: stored.length };
    }

    const byMessage = new Map<string, typeof stored>();
    for (const row of stored) {
      const existing = byMessage.get(row.platformMessageId);
      if (existing) existing.push(row);
      else byMessage.set(row.platformMessageId, [row]);
    }

    const updates: { id: number; sourceUrl: string; mimeType?: string }[] = [];
    let beyondReach = 0;

    for (const [platformMessageId, rows] of byMessage) {
      const links = fresh.get(platformMessageId);
      if (!links) {
        // Outside the window Meta returned. Permanently unrecoverable.
        beyondReach += rows.length;
        continue;
      }
      /*
       * MATCHED BY POSITION, and only when the counts agree. Both sides are
       * filtered to expiring links in the same order, so position is meaningful
       * — but if Meta returns a different number than we hold, something about
       * the message has changed and guessing which link belongs to which row
       * would put a customer's photo under the wrong bubble.
       */
      if (links.length !== rows.length) {
        beyondReach += rows.length;
        continue;
      }
      rows.forEach((row, index) => {
        const fresh = links[index];
        if (!fresh) return;
        // The mime type is worth writing even when the link has not moved: it
        // may be the first time Meta has told us what this actually is.
        if (fresh.url === row.sourceUrl && !fresh.mimeType) return;
        updates.push({
          id: row.id,
          sourceUrl: fresh.url,
          ...(fresh.mimeType ? { mimeType: fresh.mimeType } : {}),
        });
      });
    }

    const refreshed = await this.attachments.refreshSourceUrls(enterpriseId, updates);

    this.logger.info(
      { enterpriseId, conversationId: conversation.id, refreshed, beyondReach },
      'refreshed expired attachment links',
    );
    return { refreshed, beyondReach };
  }

  /**
   * The thread as Meta describes it now: message id to its expiring links, WITH
   * whatever Meta says each one is.
   *
   * The mime type comes back on the read edge and not on a webhook, so a
   * re-read is the only chance to settle a kind that was guessed at when the
   * message first arrived — a shared story stored as an image whose link is
   * really a video. Carrying it costs nothing: it arrived in a call already
   * being made.
   */
  private async readFreshAttachmentLinks(
    conversation: ConversationRow,
    channel: { platformChannelId: string; parentPlatformChannelId: string | null },
    token: string,
    participantId: string,
  ): Promise<Map<string, { url: string; mimeType: string | null }[]>> {
    const instagram = conversation.platform === Platform.Instagram;
    /*
     * An Instagram thread is read through its PARENT Page — the Instagram node
     * has no conversations edge of its own — which is the same reason the send
     * path resolves a parent token.
     */
    const readAs = instagram ? channel.parentPlatformChannelId : channel.platformChannelId;
    if (!readAs) return new Map();

    const page = instagram
      ? await this.graph.listInstagramConversations(readAs, token, undefined, participantId)
      : await this.graph.listPageConversations(readAs, token, undefined, participantId);

    const links = new Map<string, { url: string; mimeType: string | null }[]>();
    for (const thread of page.data ?? []) {
      for (const message of thread.messages?.data ?? []) {
        const translated = toWebhookAttachments(
          message.attachments?.data ?? [],
          message.shares?.data ?? [],
        );
        // Same filter as the stored side, so the two lists line up by position.
        const expiring = translated
          .filter((attachment) => isExpiringMediaUrl(attachment.payload.url))
          .map((attachment) => ({
            url: attachment.payload.url,
            mimeType: attachment.payload.mime_type ?? null,
          }));
        if (expiring.length > 0) links.set(message.id, expiring);
      }
    }
    return links;
  }

  /**
   * Replies to a conversation.
   *
   * The transactional outbox in practice: the message row and the
   * outbound_events row are written in ONE transaction and the platform call
   * happens afterwards, in the relay. Writing the row and then calling Meta
   * inline would lose the reply whenever the process died in between — and would
   * hold a transaction open across a third-party call.
   */
  async reply(
    actor: { enterpriseId: number; employeeId: number | null },
    input: ReplyInput,
  ): Promise<ReplyResult> {
    if (actor.employeeId === null) throw new AppException(ErrorCode.AuthNoActiveEmployment);

    // Validation and reads happen BEFORE the transaction opens, so it stays short.
    const conversation = await this.requireConversation(
      actor.enterpriseId,
      input.conversationRefId,
      'reply',
    );

    /*
     * A CLOSED THREAD IS CLOSED. Only `archived` refused a reply, so an agent
     * could answer a conversation somebody else had already resolved — which is
     * the thing a status is for. An internal note is still allowed: a note is a
     * record for colleagues, not a message to a customer, and forbidding one on
     * a resolved thread would stop people writing down why it was resolved.
     */
    if (CLOSED_TO_REPLIES.has(conversation.status) && !input.internalNote) {
      throw new AppException(ErrorCode.ConversationClosed);
    }
    if (conversation.status === ConversationStatus.Archived) {
      // Archived refuses even a note: it is the terminal state, and the thread
      // is out of the working set entirely.
      throw new AppException(ErrorCode.ConversationClosed);
    }

    // An idempotent retry returns the ORIGINAL result rather than a 409: the
    // caller asked for one message and got one message.
    {
      const existing = await this.messages.findByIdempotencyKey(
        actor.enterpriseId,
        input.idempotencyKey,
      );
      if (existing) {
        /*
         * SAME KEY, SAME REQUEST — or an error.
         *
         * The key is unique per TENANT, so reusing one on another conversation
         * used to return the first conversation's message with a 202: the caller
         * was told its reply was accepted, the reply was never written, and
         * nothing anywhere recorded that a customer had been left unanswered.
         * A reused key is a client bug, and it is told so.
         */
        if (
          existing.conversationId !== conversation.id ||
          existing.isInternalNote !== input.internalNote
        ) {
          throw new AppException(ErrorCode.IdempotencyKeyReused);
        }
        return { messageRefId: existing.refId, status: existing.status };
      }
    }

    // An internal note never leaves the building, so the send-path checks below
    // do not apply to it.
    if (!input.internalNote) {
      const channel = await this.channels.findSendContext(
        actor.enterpriseId,
        conversation.channelId,
      );
      if (!channel) throw new AppException(ErrorCode.ChannelNotFound);
      // Fail fast, before a row is queued that the relay could only cancel.
      if (channel.reauthRequired) throw new AppException(ErrorCode.ChannelReauthRequired);
      if (!channel.isManaged) throw new AppException(ErrorCode.ChannelNotManaged);

      /*
       * The messaging window, refused HERE rather than discovered by the relay.
       *
       * Accepting this reply would return 202, queue a row, spend an attempt,
       * and dead-letter it — after telling the agent it was on its way. The
       * platform's answer is knowable before any of that, so it is answered
       * before any of that.
       */
      const window = evaluateReplyWindow({
        conversationKind: conversation.conversationKind,
        lastInboundAt: conversation.lastInboundAt,
      });
      if (!window.canReply) {
        throw new AppException(
          ErrorCode.MessagingWindowClosed,
          window.reason ? { message: window.reason } : {},
        );
      }
    }

    const employeeId = actor.employeeId;

    /*
     * WHAT THIS ANSWERS, resolved BEFORE the transaction opens so a bad ref_id
     * is a 404 rather than a rolled-back write.
     *
     * An internal note answers nothing on the platform — it is a record for
     * colleagues — so a target is refused there rather than quietly ignored.
     */
    let replyTarget: {
      id: number;
      platformMessageId: string | null;
      deletedOnPlatform: boolean;
    } | null = null;
    if (input.replyToMessageRefId !== undefined) {
      replyTarget = await this.messages.findReplyTarget(
        actor.enterpriseId,
        conversation.id,
        input.replyToMessageRefId,
      );
      if (!replyTarget) throw new AppException(ErrorCode.MessageNotFound);
      /*
       * A message we hold but the platform never gave an id — an internal note,
       * or a send that has not left the relay yet. There is nothing to quote to
       * Meta, and sending without reply_to would silently drop the threading the
       * agent asked for.
       */
      if (!replyTarget.platformMessageId) throw new AppException(ErrorCode.ReplyNotSupported);

      /*
       * UNSENT ON THE PLATFORM. We keep the row and still show it, but Meta no
       * longer has the message and refuses reply_to against it with a bare
       * "Invalid parameter" — which the relay can only dead-letter, so the
       * agent's reply is lost after they have typed it. Refused here instead,
       * before anything is written or sent.
       *
       * The control is hidden for these anyway; this covers a message unsent
       * between the thread being opened and the reply being sent, which is
       * exactly how it happened the first time.
       */
      if (replyTarget.deletedOnPlatform) throw new AppException(ErrorCode.ReplyNotSupported);
    }

    return this.tx.runInTransaction(async () => {
      const message = await this.messages.insertOutbound({
        enterpriseId: actor.enterpriseId,
        conversationId: conversation.id,
        customerId: conversation.customerId,
        sentByEmployeeId: employeeId,
        body: input.body,
        messageKind: MessageKind.Text,
        idempotencyKey: input.idempotencyKey,
        // The same link the inbound side keeps, so the thread reads the same
        // way whoever wrote the reply.
        parentMessageId: replyTarget?.id ?? null,
        isInternalNote: input.internalNote,
      });

      if (!input.internalNote) {
        /*
         * Resolved from the kind map, not a ternary. Non-null is guaranteed by
         * the window check above, which refuses a kind the platform gives us no
         * way to answer — asserted here rather than assumed, because the two
         * live in different functions.
         */
        const eventType = replyEventTypeFor(conversation.conversationKind);
        if (eventType === null) throw new AppException(ErrorCode.ReplyNotSupported);

        const event = await this.outbound.enqueue({
          enterpriseId: actor.enterpriseId,
          channelId: conversation.channelId,
          destinationKind: DestinationKind.Channel,
          destinationId: String(conversation.channelId),
          platform: conversation.platform,
          eventType,
          inReplyToEventId: null,
          // The comment thread's root id is what a reply is posted against.
          recipientPlatformId: stripThreadPrefix(conversation.platformThreadId),
          // Keyed on the CAUSING row, because an outbound send has no platform
          // id yet and hashing the body would collide two identical replies.
          dedupKey: outboundDedupKey(conversation.platform, eventType, 'messages', message.id),
          correlationId: RequestContext.correlationId() ?? null,
          payload:
            eventType === OutboundEventType.MentionReply
              ? {
                  /*
                   * The media id comes from the CONVERSATION, not the thread
                   * key: the thread key is the comment that named us, and
                   * Meta's mentions edge needs the post it sits on as well.
                   * Resolved when the mention was projected and filed there.
                   */
                  mediaId: requireMentionMediaId(conversation.contextMetadata),
                  /*
                   * FROM THE METADATA, NOT THE THREAD KEY.
                   *
                   * For a COMMENT mention the thread key is the comment that
                   * named us, so stripping its prefix happened to give the
                   * right answer. For a CAPTION mention there is no comment at
                   * all and the key is `mention:<mediaId>` — so the media id
                   * was being sent to Meta as a comment id, and the reply
                   * dead-lettered after the agent had been told 202.
                   *
                   * Null is the correct value for a caption mention, not a
                   * missing one: `replyToMention` omits `comment_id` when it is
                   * absent, and that is exactly the shape that posts a
                   * top-level comment on the tagged post
                   * (platform-limitations 1.7b).
                   */
                  commentId: mentionCommentId(conversation.contextMetadata),
                  message: input.body,
                }
              : eventType === OutboundEventType.CommentReply
              ? { commentId: stripThreadPrefix(conversation.platformThreadId), message: input.body }
              : {
                  message: input.body,
                  ...(replyTarget?.platformMessageId
                    ? { replyToPlatformMessageId: replyTarget.platformMessageId }
                    : {}),
                },
          scheduledAt: null,
        });

        if (event.id !== null) {
          await this.messages.linkOutboundEvent(actor.enterpriseId, message.id, event.id);
        }
      }

      await this.conversations.recordMessage({
        enterpriseId: actor.enterpriseId,
        conversationId: conversation.id,
        inbound: false,
        occurredAt: new Date(),
      });

      /*
       * A reply is announced too, so a colleague watching the same conversation
       * sees it without reloading — and so two agents are less likely to answer
       * the same customer twice.
       */
      await this.conversations.notifyChanged({
        enterpriseId: actor.enterpriseId,
        conversationRefId: conversation.refId,
        conversationKind: conversation.conversationKind,
        kind: 'outbound',
      });

      if (conversation.customerId) {
        await this.customers.recordEngagement({
          enterpriseId: actor.enterpriseId,
          customerId: conversation.customerId,
          channelId: conversation.channelId,
          platform: conversation.platform,
          inbound: false,
          conversationId: conversation.id,
        });
      }

      this.logger.info(
        { conversationId: conversation.id, internalNote: input.internalNote },
        'reply queued',
      );

      // Pending, not sent: the relay sends after this transaction commits.
      return {
        messageRefId: message.refId,
        status: input.internalNote ? MessageStatus.Delivered : MessageStatus.Pending,
      };
    });
  }

  /**
   * Hands a conversation to a colleague, or takes it back.
   *
   * ANNOUNCED and AUDITED, both of which were missing. Without the announcement
   * a colleague's inbox showed the conversation as unassigned until they
   * reloaded, which is how two agents end up answering the same customer — the
   * exact failure a shared inbox exists to prevent. Without the audit row there
   * was no record of who took what.
   */
  async assign(
    enterpriseId: number,
    conversationRefId: string,
    employeeRefId: string | null,
  ): Promise<void> {
    /*
     * RESOLVED HERE, NOT IN THE CONTROLLER, and scoped to this enterprise — so
     * a refId belonging to another tenant does not resolve and cannot be handed
     * work. It read the repository from the controller before, which put the
     * one rule that makes assignment tenant-safe in the layer least likely to
     * be looked at when assignment changes.
     */
    let employeeId: number | null = null;
    if (employeeRefId !== null) {
      const employee = await this.employees.findByRefId(enterpriseId, employeeRefId);
      if (!employee) throw new AppException(ErrorCode.EmployeeNotFound);
      employeeId = employee.employeeId;
    }

    const conversation = await this.requireConversation(enterpriseId, conversationRefId, 'assign');
    if (conversation.assignedToEmployeeId === employeeId) return;

    await this.conversations.assign(enterpriseId, conversation.id, employeeId);

    await this.audit.record({
      action: AuditAction.Assigned,
      entityType: AuditEntityType.Conversation,
      entityId: conversation.id,
      enterpriseId,
      changes: {
        assignedToEmployeeId: { from: conversation.assignedToEmployeeId, to: employeeId },
      },
    });

    await this.conversations.notifyChanged({
      enterpriseId,
      conversationRefId: conversation.refId,
      conversationKind: conversation.conversationKind,
      kind: 'assigned',
    });
  }

  async setStatus(
    enterpriseId: number,
    conversationRefId: string,
    status: ConversationStatus,
  ): Promise<void> {
    const conversation = await this.requireConversation(enterpriseId, conversationRefId, 'manage');
    // A no-op is reported as success and does nothing: re-resolving an already
    // resolved conversation is not an error, but it is not an event either.
    if (conversation.status === status) return;

    await this.conversations.setStatus(enterpriseId, conversation.id, status);

    await this.audit.record({
      action: AuditAction.Updated,
      entityType: AuditEntityType.Conversation,
      entityId: conversation.id,
      enterpriseId,
      changes: { status: { from: conversation.status, to: status } },
    });

    await this.conversations.notifyChanged({
      enterpriseId,
      conversationRefId: conversation.refId,
      conversationKind: conversation.conversationKind,
      kind: 'status',
    });
  }

  /**
   * Hides, unhides or deletes one comment on a post we own.
   *
   * OWNERSHIP OF THE POST IS THE WHOLE PERMISSION, and it is checked here
   * rather than left to Meta. Instagram allows moderation only to the owner of
   * the media a comment sits on — explicitly "even if the user attempting to
   * delete the comment is the comment's author" — so a comment on somebody
   * else's post can never be moderated by us, and sending it anyway would
   * spend a rate-limited call to be refused and then dead-letter, with the
   * agent told nothing useful (docs/platform-limitations.md §1.8, §1.10).
   *
   * `post_id` is that proof: the projector fills it only when the comment's
   * media matches a row in our own posts.
   *
   * The platform call goes through the OUTBOX, like every other outbound write
   * — the row and the event commit together and the relay does the talking.
   */
  async moderateComment(
    enterpriseId: number,
    conversationRefId: string,
    messageRefId: string,
    action: 'hide' | 'unhide' | 'delete',
  ): Promise<{ messageRefId: string; action: string }> {
    const conversation = await this.requireConversation(enterpriseId, conversationRefId, 'manage');

    /*
     * HIDING AND DELETING ARE THEIR OWN PERMISSIONS, and always were — the
     * catalogue has carried `comments.hide` and `comments.delete` since the
     * beginning and nothing enforced either. The route asked for
     * `conversations.manage`, so anybody who could close a thread could also
     * delete a customer's comment from a public post, which is not recoverable.
     */
    const needed = action === 'delete' ? Permission.CommentsDelete : Permission.CommentsHide;
    if (!RequestContext.actor()?.permissions.has(needed)) {
      throw new AppException(ErrorCode.PermissionDenied, {
        details: [{ field: 'permission', issue: needed }],
      });
    }

    /*
     * Not a comment thread, or a comment thread on a post that is not ours:
     * refused before anything is written or sent.
     */
    if (conversation.conversationKind !== ConversationKind.CommentThread) {
      throw new AppException(ErrorCode.ReplyNotSupported, {
        details: [{ field: 'action', issue: 'only a comment can be moderated' }],
      });
    }
    if (conversation.postId === null) {
      throw new AppException(ErrorCode.ReplyNotSupported, {
        details: [
          { field: 'action', issue: 'Instagram allows this only on a post you own' },
        ],
      });
    }

    const target = await this.messages.findModerationTarget(
      enterpriseId,
      conversation.id,
      messageRefId,
    );
    if (!target) throw new AppException(ErrorCode.MessageNotFound);

    // A comment the platform never gave an id — an internal note — has nothing
    // to moderate there.
    if (!target.platformMessageId) {
      throw new AppException(ErrorCode.ReplyNotSupported, {
        details: [{ field: 'action', issue: 'this message does not exist on the platform' }],
      });
    }

    /*
     * ALREADY GONE FROM THE PLATFORM — but only when the PLATFORM said so.
     *
     * A deleted comment used to set our own is_deleted flag and so could never
     * be found here. Now that a deletion is MARKED rather than erased, the row
     * comes back like any other, and hiding or deleting something Instagram has
     * already removed is a call it refuses after the agent was told it worked.
     *
     * OUR OWN MARK IS NOT EVIDENCE OF THAT. It is written optimistically, in
     * the same transaction as the outbound event, because Instagram sends no
     * webhook when a comment is hidden or deleted. So a delete that then
     * dead-letters leaves the comment live on Instagram and marked here — and
     * refusing on that would make every retry impossible, which is the one
     * moment a retry is what the agent needs.
     *
     * `deletedByBusiness` is exactly that distinction: set when we asked,
     * absent when Meta told us.
     */
    if (target.deletedOnPlatform && !target.deletedByBusiness) {
      throw new AppException(ErrorCode.InvalidStateTransition, {
        details: [
          { field: 'action', issue: 'this comment is already gone from the platform' },
        ],
      });
    }

    // Already in the asked-for state: a conflict rather than a wasted call.
    if (
      (action === 'hide' && target.isHiddenOnPlatform) ||
      (action === 'unhide' && !target.isHiddenOnPlatform)
    ) {
      throw new AppException(ErrorCode.InvalidStateTransition, {
        details: [{ field: 'action', issue: `already ${action === 'hide' ? 'hidden' : 'visible'}` }],
      });
    }

    const eventType =
      action === 'delete' ? OutboundEventType.CommentDelete : OutboundEventType.CommentHide;

    return this.tx.runInTransaction(async () => {
      await this.outbound.enqueue({
        enterpriseId,
        channelId: conversation.channelId,
        destinationKind: DestinationKind.Channel,
        destinationId: String(conversation.channelId),
        platform: conversation.platform,
        eventType,
        inReplyToEventId: null,
        recipientPlatformId: target.platformMessageId,
        /*
         * Keyed on the ACTION as well as the message, so hiding and later
         * unhiding the same comment are two events rather than the second
         * colliding with the first and being dropped.
         */
        dedupKey: outboundDedupKey(conversation.platform, eventType, `messages:${action}`, target.id),
        correlationId: RequestContext.correlationId() ?? null,
        payload: {
          commentId: target.platformMessageId,
          ...(action === 'delete' ? {} : { hidden: action === 'hide' }),
        },
        scheduledAt: null,
      });

      /*
       * Applied locally in the same transaction, OPTIMISTICALLY. Instagram
       * sends no webhook when a comment is hidden or deleted, so waiting to be
       * told would mean the inbox never updated. A failed call dead-letters in
       * the ledger, which is where the disagreement surfaces.
       */
      await this.messages.applyOwnModeration({ enterpriseId, messageId: target.id, action });

      return { messageRefId, action };
    });
  }

  async markRead(enterpriseId: number, conversationRefId: string): Promise<void> {
    const conversation = await this.requireConversation(enterpriseId, conversationRefId, 'view');
    await this.conversations.markRead(enterpriseId, conversation.id);
  }

  /**
   * Ownership is checked HERE, in the service, as part of the normal fetch —
   * not in a guard. A guard that loaded the conversation would push a query
   * outside the service layer and duplicate it.
   *
   * A conversation belonging to another tenant is a 404, not a 403: a 403 would
   * confirm that the refId exists.
   */
  /**
   * The conversation, and the right to do this to THIS KIND of conversation.
   *
   * The action is a required parameter rather than an option with a default,
   * and that is the point: a direct message, a comment thread and a mention are
   * governed by different permissions, the route cannot tell which until the
   * row is loaded, and a call site that forgot to say what it was doing would
   * otherwise silently get the most permissive reading. Making it required
   * turns that into a compile error.
   */
  private async requireConversation(
    enterpriseId: number,
    conversationRefId: string,
    action: ConversationAction,
  ): Promise<ConversationRow> {
    const conversation = await this.conversations.findByRefId(enterpriseId, conversationRefId);
    if (!conversation) throw new AppException(ErrorCode.ConversationNotFound);

    const needed = permissionFor(conversation.conversationKind, action);
    const held = RequestContext.actor()?.permissions;
    if (!held?.has(needed)) {
      /*
       * NOT FOUND, not FORBIDDEN, and deliberately.
       *
       * The route is reachable by anyone holding the equivalent right on any
       * kind of thread, so a 403 here would confirm that a particular
       * conversation ref exists to somebody who may not see it — and refIds are
       * the only identifier a client holds, which makes that a usable oracle.
       * Somebody who cannot see a thread should find it indistinguishable from
       * one that is not there.
       */
      throw new AppException(ErrorCode.ConversationNotFound);
    }

    return conversation;
  }
}

function decodeInboxCursor(
  cursor: string | null,
): { lastMessageAt: Date | null; id: number } | null {
  const parsed = decodeKeysetCursor(cursor);
  return parsed && { lastMessageAt: parsed.at, id: parsed.id };
}

function decodeThreadCursor(cursor: string | null): { sortedAt: Date; id: number } | null {
  const parsed = decodeKeysetCursor(cursor);
  /*
   * The thread's sort key is COALESCE(platform_sent_at, created_at) and
   * created_at is NOT NULL, so it can never be null. A cursor claiming
   * otherwise did not come from this listing.
   */
  return parsed?.at ? { sortedAt: parsed.at, id: parsed.id } : null;
}

/** `comment:123` -> `123`. The prefix is ours; the platform never sees it. */
/**
 * The post a mention lives on.
 *
 * Read here rather than trusted blindly at the relay: a mention projected
 * before the Mentions API was wired in has no post recorded, and discovering
 * that at send time means the agent's reply dead-letters after they typed it.
 */
function mentionMediaId(contextMetadata: Record<string, unknown>): string | null {
  const mediaId = contextMetadata.mentionedMediaId;
  return typeof mediaId === 'string' && mediaId.length > 0 ? mediaId : null;
}

/**
 * The same thing, but REFUSING rather than passing null down the queue.
 *
 * The paragraph above says the check is here so the agent does not discover
 * the problem after typing — and then the null was handed to the relay anyway,
 * which accepted the reply, answered 202, and dead-lettered it a moment later
 * with nobody watching. A refusal the person can read at the moment they press
 * send is the entire point, and it was one line short of happening.
 */
function requireMentionMediaId(contextMetadata: Record<string, unknown>): string {
  const mediaId = mentionMediaId(contextMetadata);
  if (mediaId === null) {
    throw new AppException(ErrorCode.ReplyNotSupported, {
      details: [
        {
          field: 'conversationRefId',
          issue:
            'this mention was stored before the post it sits on was recorded, so there is ' +
            'nowhere to send a reply — open it on the platform instead',
        },
      ],
    });
  }
  return mediaId;
}

/**
 * The comment that named us, when one did.
 *
 * Null for a caption mention, where the tag is in the post's own caption and
 * there is no comment anywhere. That null is meaningful rather than missing —
 * it is what tells Meta to answer the POST instead of a comment on it.
 */
function mentionCommentId(contextMetadata: Record<string, unknown>): string | null {
  const commentId = contextMetadata.mentionedCommentId;
  return typeof commentId === 'string' && commentId.length > 0 ? commentId : null;
}

function stripThreadPrefix(platformThreadId: string): string {
  const separator = platformThreadId.indexOf(':');
  return separator === -1 ? platformThreadId : platformThreadId.slice(separator + 1);
}

/**
 * Every platform comment id in a mention's stored thread.
 *
 * Reads defensively because this is stored JSON shaped by whatever the Mentions
 * API gave us on the day: a thread that is absent, or an entry with no id, is
 * ordinary rather than exceptional.
 */
export function threadCommentIds(contextMetadata: Record<string, unknown>): string[] {
  const parent =
    typeof contextMetadata.mentionParent === 'object' && contextMetadata.mentionParent !== null
      ? (contextMetadata.mentionParent as Record<string, unknown>)
      : null;

  /*
   * ALL THREE LISTS, because a comment we know about can appear in any of them.
   *
   * The parent thread was the only one collected, so the wider comment section
   * went out entirely unnamed — including the mention itself, which is a real
   * comment on that post and comes back in the list like any other. An agent
   * saw their own tag attributed to "someone".
   *
   * `replyThread` was still missing after that fix, and it is the one that
   * hurts most: those are the replies directly UNDER our mention, which is
   * where the business's own answer sits. So the reply an agent had just sent
   * came back attributed to a stranger — the exact case this naming exists
   * for, and the only list whose authors we can always identify.
   *
   * One query either way: the ids simply go in together.
   */
  return [
    ...platformIds(parent?.replies),
    ...platformIds(contextMetadata.replyThread),
    ...platformIds(contextMetadata.postComments),
  ];
}

/** The platform comment ids in a stored, loosely-shaped comment list. */
function platformIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) =>
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>).platformId
        : null,
    )
    .filter((id): id is string => typeof id === 'string');
}

/**
 * Resolves `work`, or null if it takes longer than `budgetMs`.
 *
 * The loser is not abandoned carelessly: a rejection arriving after the budget
 * has passed would otherwise be an unhandled rejection, which in Node takes the
 * process down. It is caught and discarded, and the timer is always cleared so
 * a fast answer does not hold the event loop open for the rest of the budget.
 *
 * Nothing is written by the abandoned call — losing the race means the stored
 * answer is served and the next read tries again, rather than a write landing
 * from a request that has already finished.
 */
async function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });

  try {
    return await Promise.race([
      work.catch(() => {
        throw new Error('the platform call failed');
      }),
      expiry,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // The race may already be decided; this keeps a late rejection from
    // escaping as an unhandled one.
    void work.catch(() => undefined);
  }
}
