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

/** The shape Meta sends for a feed/comment change. */
interface CommentChange {
  readonly field?: string;
  readonly value?: {
    readonly item?: string;
    readonly verb?: string;
    readonly comment_id?: string;
    readonly parent_id?: string;
    readonly post_id?: string;
    readonly message?: string;
    readonly created_time?: number;
    readonly from?: { readonly id?: string; readonly name?: string };
  };
}

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
    const change = payload as CommentChange;
    const value = change.value;

    // A feed change covers posts, likes, and shares as well as comments. Only a
    // comment projects into the inbox; the rest are skipped explicitly rather
    // than half-handled.
    if (!value || value.item !== 'comment' || !value.comment_id) {
      return { projected: false, reason: `not a comment (item="${value?.item ?? 'none'}")` };
    }
    // A removal is not a new message. Handling deletions needs its own path.
    if (value.verb === 'remove' || value.verb === 'hide') {
      return { projected: false, reason: `comment verb "${value.verb}" is not projected yet` };
    }

    const authorPlatformId = value.from?.id;
    if (!authorPlatformId) {
      return { projected: false, reason: 'the comment names no author' };
    }

    const identifierKind =
      platform === Platform.Instagram
        ? IdentifierKind.InstagramUserId
        : IdentifierKind.FacebookUserId;

    /*
     * The thread key: one conversation per TOP-LEVEL comment thread. parent_id
     * is the root when the comment is a reply; otherwise the comment is itself
     * the root. Without this, a reply would open its own thread and the
     * conversation would fragment.
     */
    const rootCommentId = value.parent_id ?? value.comment_id;
    // Captured before the closure: the guard above proved these are present, but
    // that narrowing does not survive into a callback.
    const commentId = value.comment_id;
    const parentId = value.parent_id ?? null;

    return this.tx.runInTransaction(async () => {
      const customer = await this.customers.resolveOrCreate({
        enterpriseId,
        identifierKind,
        identifierValue: authorPlatformId,
        identifierValueRaw: authorPlatformId,
        displayName: normalizeOptionalText(value.from?.name ?? null),
        firstSource:
          platform === Platform.Instagram
            ? CustomerFirstSource.InstagramComment
            : CustomerFirstSource.FacebookComment,
        firstChannelId: channelId,
        // The platform vouches for this id: it issued it.
        source: IdentifierSource.Platform,
        verificationStatus: IdentifierVerificationStatus.Verified,
      });

      const conversation = await this.conversations.upsert({
        enterpriseId,
        channelId,
        customerId: customer.customerId,
        customerIdentifierId: customer.identifierId,
        postId: null,
        platform,
        conversationKind: ConversationKind.CommentThread,
        platformThreadId: composeThreadKey(ConversationKind.CommentThread, rootCommentId),
        subject: normalizeOptionalText(value.message ?? null)?.slice(0, 500) ?? null,
      });

      // A reply threads under its parent when we already hold it.
      const parentMessageId = parentId
        ? await this.messages.findIdByPlatformId(enterpriseId, parentId)
        : null;

      const inserted = await this.messages.insertInbound({
        enterpriseId,
        conversationId: conversation.id,
        customerId: customer.customerId,
        inboundEventId,
        platformMessageId: commentId,
        messageKind: MessageKind.Text,
        body: value.message ?? null,
        platformSentAt: value.created_time ? new Date(value.created_time * 1000) : null,
        parentMessageId,
      });

      // Null means the unique index rejected it: this comment is already stored,
      // so the counters must NOT be incremented again.
      if (!inserted) {
        return { projected: false, reason: 'the comment was already projected' };
      }

      const occurredAt = value.created_time ? new Date(value.created_time * 1000) : new Date();
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

      // No message text, no author name: those are the customer's words.
      this.logger.debug(
        { enterpriseId, conversationId: conversation.id, newCustomer: customer.created },
        'comment projected',
      );

      return { projected: true };
    });
  }
}
