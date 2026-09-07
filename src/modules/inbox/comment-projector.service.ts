import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import {
  ConversationRepository,
  composeThreadKey,
} from '@/database/repositories/conversation.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { PostRepository } from '@/database/repositories/post.repository';
import { TransactionManager } from '@/database/transaction';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import { TokenCipherService } from '@/shared/crypto/token-cipher.service';
import {
  ConversationKind,
  CustomerFirstSource,
  IdentifierKind,
  IdentifierSource,
  IdentifierVerificationStatus,
  MessageKind,
  Platform,
} from '@/shared/enums';
import { normalizeOptionalText } from '@/shared/utils/normalize';
import { normalizeComment, normalizeMention } from './comment-normalizer';
import type { CanonicalComment, CommentModeration } from './comment-normalizer';

export interface ProjectionOutcome {
  readonly projected: boolean;
  readonly reason?: string;
}

/**
 * Projects a comment event into customers, conversations, and messages.
 *
 * ONE TRANSACTION for the whole projection: a partially projected event — a
 * conversation with no message, or a message with no customer — is worse than no
 * projection at all, because the ledger row is then marked processed and nothing
 * will revisit it.
 */
@Injectable()
export class CommentProjectorService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly channels: ChannelRepository,
    private readonly posts: PostRepository,
    private readonly graph: GraphApiClient,
    private readonly cipher: TokenCipherService,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(CommentProjectorService.name) private readonly logger: PinoLogger,
  ) {}

  async project(
    enterpriseId: number,
    channelId: number,
    platform: Platform,
    inboundEventId: number,
    payload: unknown,
    ownPlatformIds: readonly string[] = [],
  ): Promise<ProjectionOutcome> {
    /*
     * Both platforms' shapes collapse to one here. Previously this method read
     * the Facebook shape directly, which meant every Instagram comment was
     * skipped as "not a comment".
     */
    const normalized = normalizeComment(platform, payload);
    if ('skip' in normalized) return { projected: false, reason: normalized.skip };

    /*
     * A CHANGE to a comment we may already hold — an edit, a removal, a hide.
     * These were ingested and then dropped, so the inbox went on showing a
     * comment the customer had deleted.
     */
    if ('moderation' in normalized) {
      return this.applyModeration(enterpriseId, normalized.moderation);
    }

    if (isOwnAuthor(normalized.comment.authorPlatformId, ownPlatformIds)) {
      return { projected: false, reason: OWN_CONTENT_REASON };
    }

    return this.store(
      enterpriseId,
      channelId,
      platform,
      inboundEventId,
      normalized.comment,
      ConversationKind.CommentThread,
      platform === Platform.Instagram
        ? CustomerFirstSource.InstagramComment
        : CustomerFirstSource.FacebookComment,
    );
  }

  /**
   * A mention: somebody tagged the account in their OWN post or comment.
   *
   * Same storage path as a comment, because the inbox does the same work —
   * resolve the person, open a thread, store one message. Only the conversation
   * kind differs, which is why this is a second entry point rather than a second
   * projector.
   */
  async projectMention(
    enterpriseId: number,
    channelId: number,
    platform: Platform,
    inboundEventId: number,
    payload: unknown,
    ownPlatformIds: readonly string[] = [],
  ): Promise<ProjectionOutcome> {
    /*
     * THE WEBHOOK IS A NOTIFICATION, NOT THE MENTION.
     *
     * Instagram's `mentions` change carries a media id and a comment id and
     * NOTHING ELSE — no author, no text — so every live mention was skipped for
     * want of an author and the feature was dead end to end: subscribed,
     * routed, normalized, and never once projected. Only the /tags backfill,
     * which returns the tagger's handle, ever produced one.
     *
     * The content is one call away, so it is fetched before normalizing rather
     * than teaching the normalizer to invent an author it does not have.
     */
    const resolved =
      platform === Platform.Instagram
        ? await this.resolveInstagramMention(enterpriseId, channelId, payload)
        : payload;

    const normalized = normalizeMention(platform, resolved);
    if ('skip' in normalized) return { projected: false, reason: normalized.skip };

    if ('moderation' in normalized) {
      return this.applyModeration(enterpriseId, normalized.moderation);
    }

    // A business tagging itself is not a mention worth an inbox row.
    if (isOwnAuthor(normalized.comment.authorPlatformId, ownPlatformIds)) {
      return { projected: false, reason: OWN_CONTENT_REASON };
    }

    return this.store(
      enterpriseId,
      channelId,
      platform,
      inboundEventId,
      normalized.comment,
      ConversationKind.Mention,
      platform === Platform.Instagram
        ? CustomerFirstSource.InstagramComment
        : CustomerFirstSource.FacebookComment,
    );
  }

  /**
   * Applies what Meta did to a comment we already stored.
   *
   * These events were arriving all along — the verb is part of the dedup key, so
   * each one got its own ledger row — and the projector threw every one away. A
   * customer deleting their comment, or an agent hiding one, changed nothing in
   * the inbox.
   *
   * A comment we never stored is a SKIP rather than a failure: it may predate the
   * connection, or have been the business's own, or have been dropped for a
   * reason this projector already recorded. Retrying would not make it appear.
   */
  private async applyModeration(
    enterpriseId: number,
    moderation: CommentModeration,
  ): Promise<ProjectionOutcome> {
    const applied = await this.messages.applyPlatformModeration({
      enterpriseId,
      platformMessageId: moderation.commentId,
      action: moderation.action,
      text: moderation.text,
    });

    if (!applied) {
      return {
        projected: false,
        reason: `nothing stored for comment ${moderation.commentId} to ${moderation.action}`,
      };
    }

    // No text: an edit's new body is the customer's words.
    this.logger.debug({ enterpriseId, action: moderation.action }, 'comment moderation applied');
    return { projected: true };
  }

  /**
   * Fills a `mentions` webhook in from the Mentions API.
   *
   * Returns the payload UNCHANGED when there is nothing to do or nothing to be
   * had, so the normalizer decides what is projectable in one place. A mention
   * that still has no author is skipped there with the reason it already had —
   * this never manufactures one.
   *
   * A FAILURE HERE MUST NOT FAIL THE PROJECTION. The alternative is a ledger row
   * that retries against Meta on every pass, spending rate limit on a mention
   * that may simply be unreadable — a deleted comment, a post gone private. The
   * event is projected without the enrichment where it can be, and skipped with
   * a reason where it cannot.
   */
  private async resolveInstagramMention(
    enterpriseId: number,
    channelId: number,
    payload: unknown,
  ): Promise<unknown> {
    const change = payload as {
      readonly field?: string;
      readonly value?: { readonly media_id?: string; readonly comment_id?: string; readonly username?: string };
    };
    const value = change?.value;
    if (!value) return payload;

    // The backfill already supplies an author; only the webhook needs this.
    if (value.username) return payload;
    if (!value.comment_id && !value.media_id) return payload;

    const channel = await this.channels.findBackfillContext(enterpriseId, channelId);
    if (!channel?.effectiveAccessToken || !channel.platformChannelId) return payload;
    // A channel already known to need re-auth would spend a call to be told so.
    if (channel.reauthRequired) return payload;

    let token: string;
    try {
      token = this.cipher.decrypt(channel.effectiveAccessToken);
    } catch {
      // Key loss or tampering. The relay and backfill both alert on this; here
      // it is enough not to project a mention we cannot read.
      return payload;
    }

    try {
      const resolution = await this.graph.resolveInstagramMention(
        channel.platformChannelId,
        { commentId: value.comment_id ?? null, mediaId: value.media_id ?? null },
        token,
      );
      if (!resolution) return payload;

      return {
        ...change,
        value: {
          ...value,
          username: resolution.authorUsername,
          // The normalizer reads the mention's words from `caption`, which is
          // what the /tags backfill calls them.
          caption: resolution.text ?? undefined,
          timestamp: resolution.timestamp ?? undefined,
          permalink: resolution.permalink ?? undefined,
          media_owner_username: resolution.mediaOwnerUsername ?? undefined,
          media_id: resolution.mediaId ?? value.media_id,
          mention_media: resolution.media ?? undefined,
          mention_replies: resolution.replies.length > 0 ? resolution.replies : undefined,
          mention_parent: resolution.parent ?? undefined,
          mention_parent_id: resolution.parentCommentId ?? undefined,
          mention_like_count:
            resolution.likeCount === null ? undefined : resolution.likeCount,
        },
      };
    } catch (error) {
      this.logger.warn(
        { err: error, enterpriseId, channelId },
        'could not resolve an instagram mention — projecting without it',
      );
      return payload;
    }
  }

  private async store(
    enterpriseId: number,
    channelId: number,
    platform: Platform,
    inboundEventId: number,
    comment: CanonicalComment,
    conversationKind: ConversationKind,
    firstSource: CustomerFirstSource,
  ): Promise<ProjectionOutcome> {
    /*
     * Stated by the normalizer when it has to be, derived otherwise.
     *
     * Instagram's `tags` edge — the only source of mention HISTORY — returns
     * another person's media with a username and no id at all, so a mention
     * backfilled from it is keyed on the handle and says so. Everything else
     * carries an app-scoped id the platform issued.
     */
    const identifierKind =
      comment.authorIdentifierKind ??
      (platform === Platform.Instagram
        ? IdentifierKind.InstagramUserId
        : IdentifierKind.FacebookUserId);

    return this.tx.runInTransaction(async () => {
      const customer = await this.customers.resolveOrCreate({
        enterpriseId,
        identifierKind,
        identifierValue: comment.authorPlatformId,
        identifierValueRaw: comment.authorPlatformId,
        displayName: normalizeOptionalText(comment.authorName),
        firstSource,
        firstChannelId: channelId,
        // The platform vouches for this id: it issued it.
        source: IdentifierSource.Platform,
        verificationStatus: IdentifierVerificationStatus.Verified,
      });

      /*
       * The handle is stored as an identifier, not only as a name: Instagram
       * gives one on every comment, and it is how a person is addressed and
       * searched for. Non-primary, because the numeric id is what survives a
       * rename.
       */
      if (comment.authorHandle && identifierKind !== IdentifierKind.InstagramUsername) {
        await this.customers.linkIdentifier({
          enterpriseId,
          customerId: customer.customerId,
          identifierKind: IdentifierKind.InstagramUsername,
          identifierValue: comment.authorHandle,
        });
      }

      const conversation = await this.conversations.upsert({
        enterpriseId,
        channelId,
        customerId: customer.customerId,
        customerIdentifierId: customer.identifierId,
        /*
         * The post this thread is about, when we hold it. This was `null`
         * unconditionally while the platform's post id sat in the payload — so
         * the column and its foreign key existed and nothing was ever linked,
         * and the inbox could not say what a comment was on.
         *
         * Null is still a legitimate answer: a comment can arrive before the
         * post has been backfilled, and the thread matters more than the link.
         */
        postId: comment.postId
          ? await this.posts.findIdByPlatformPostId(enterpriseId, channelId, comment.postId)
          : null,
        platform,
        conversationKind,
        platformThreadId: composeThreadKey(conversationKind, comment.rootCommentId),
        subject: normalizeOptionalText(comment.text)?.slice(0, 500) ?? null,
        /*
         * WHAT THIS THREAD IS ABOUT, and for a mention it is not optional
         * decoration: answering a mention needs the media id, and Meta's
         * mentions edge is the only way to answer one at all. Filing it on the
         * conversation puts it where the reply path can reach it without
         * re-reading a message's metadata to find out where to send.
         */
        ...(conversationKind === ConversationKind.Mention && comment.metadata
          ? { contextMetadata: comment.metadata }
          : {}),
      });

      // A reply threads under its parent when we already hold it.
      const parentMessageId = comment.parentId
        ? await this.messages.findIdByPlatformId(enterpriseId, comment.parentId)
        : null;

      const inserted = await this.messages.insertInbound({
        enterpriseId,
        conversationId: conversation.id,
        customerId: customer.customerId,
        inboundEventId,
        platformMessageId: comment.commentId,
        messageKind: MessageKind.Text,
        body: comment.text,
        platformSentAt: comment.createdAt,
        parentMessageId,
        // Where the mention lives and whose post it is on. Empty for a comment.
        ...(comment.metadata && Object.keys(comment.metadata).length > 0
          ? { metadata: comment.metadata }
          : {}),
      });

      // Null means the unique index rejected it: this comment is already stored,
      // so the counters must NOT be incremented again.
      if (!inserted) {
        return { projected: false, reason: 'the comment was already projected' };
      }

      const occurredAt = comment.createdAt ?? new Date();
      await this.conversations.recordMessage({
        enterpriseId,
        conversationId: conversation.id,
        inbound: true,
        occurredAt,
      });
      await this.customers.touchLastSeen(enterpriseId, customer.customerId, channelId);
      await this.customers.recordEngagement({
        enterpriseId,
        customerId: customer.customerId,
        channelId,
        platform,
        inbound: true,
        conversationId: conversation.id,
        // Only the message that opened the thread counts as a new conversation.
        conversationCreated: conversation.created,
      });

      /*
       * Announced inside the transaction, so a live inbox is told only about a
       * projection that actually committed.
       */
      await this.conversations.notifyChanged({
        enterpriseId,
        conversationRefId: conversation.refId,
        kind: 'inbound',
      });

      // No message text, no author name: those are the customer's words.
      this.logger.debug(
        { enterpriseId, conversationId: conversation.id, newCustomer: customer.created },
        'comment projected',
      );

      return { projected: true };
    });
  }
}

/**
 * The reason a projection is skipped when the author is us.
 *
 * A SKIP, not a failure: the event was understood perfectly and deliberately not
 * projected, which is a terminal, visible state rather than something to retry.
 */
const OWN_CONTENT_REASON = "the comment is the business's own, not a customer's";

/**
 * Is this author the connected account itself?
 *
 * Meta delivers the business's own comments through the same webhook as a
 * customer's, and nothing filtered them — so every agent reply that echoed back
 * created a CUSTOMER record for the business and a conversation attributed to
 * it, inflating customer counts and engagement with the business's own activity.
 * The DM projector already had Meta's `is_echo` flag for exactly this; comments
 * carry no such flag, so the author has to be compared against our own ids.
 *
 * Both ids are checked because either can appear: an Instagram comment's author
 * is the Instagram account, while the Page is what sends on its behalf.
 */
function isOwnAuthor(authorPlatformId: string, ownPlatformIds: readonly string[]): boolean {
  return ownPlatformIds.some((id) => id === authorPlatformId);
}
