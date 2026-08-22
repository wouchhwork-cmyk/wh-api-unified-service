import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import {
  ConversationRepository,
  composeThreadKey,
} from '@/database/repositories/conversation.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { TransactionManager } from '@/database/transaction';
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
import type { CanonicalComment } from './comment-normalizer';

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
    private readonly tx: TransactionManager,
    @InjectPinoLogger(CommentProjectorService.name) private readonly logger: PinoLogger,
  ) {}

  async project(
    enterpriseId: number,
    channelId: number,
    platform: Platform,
    inboundEventId: number,
    payload: unknown,
  ): Promise<ProjectionOutcome> {
    /*
     * Both platforms' shapes collapse to one here. Previously this method read
     * the Facebook shape directly, which meant every Instagram comment was
     * skipped as "not a comment".
     */
    const normalized = normalizeComment(platform, payload);
    if ('skip' in normalized) return { projected: false, reason: normalized.skip };

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
  ): Promise<ProjectionOutcome> {
    const normalized = normalizeMention(platform, payload);
    if ('skip' in normalized) return { projected: false, reason: normalized.skip };

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

  private async store(
    enterpriseId: number,
    channelId: number,
    platform: Platform,
    inboundEventId: number,
    comment: CanonicalComment,
    conversationKind: ConversationKind,
    firstSource: CustomerFirstSource,
  ): Promise<ProjectionOutcome> {
    const identifierKind =
      platform === Platform.Instagram
        ? IdentifierKind.InstagramUserId
        : IdentifierKind.FacebookUserId;

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
      if (comment.authorHandle) {
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
        postId: null,
        platform,
        conversationKind,
        platformThreadId: composeThreadKey(conversationKind, comment.rootCommentId),
        subject: normalizeOptionalText(comment.text)?.slice(0, 500) ?? null,
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
