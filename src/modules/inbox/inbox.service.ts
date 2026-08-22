import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import {
  ConversationRepository,
  type ConversationRow,
} from '@/database/repositories/conversation.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import { TransactionManager } from '@/database/transaction';
import { RequestContext } from '@/shared/context';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/shared/constants';
import {
  ConversationKind,
  ConversationStatus,
  DestinationKind,
  MessageKind,
  MessageStatus,
  OutboundEventType,
} from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { outboundDedupKey } from '@/modules/ledger/dedup-key.util';
import { evaluateReplyWindow } from './reply-window';

export interface ReplyInput {
  readonly conversationRefId: string;
  readonly body: string;
  readonly idempotencyKey: string | null;
  /** Team-only note: never sent, never touches the ledger. */
  readonly internalNote: boolean;
}

export interface ReplyResult {
  readonly messageRefId: string;
  readonly status: MessageStatus;
}

@Injectable()
export class InboxService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly outbound: OutboundEventRepository,
    private readonly channels: ChannelRepository,
    private readonly customers: CustomerRepository,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(InboxService.name) private readonly logger: PinoLogger,
  ) {}

  async listInbox(
    enterpriseId: number,
    options: {
      status: ConversationStatus | null;
      assignedToEmployeeId: number | null;
      limit: number;
      cursor: string | null;
    },
  ): Promise<{ items: ConversationRow[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = clampLimit(options.limit);
    const rows = await this.conversations.listInbox({
      enterpriseId,
      status: options.status,
      assignedToEmployeeId: options.assignedToEmployeeId,
      // One extra row is the cheapest way to know whether another page exists,
      // without a second COUNT query over the same predicate.
      limit: limit + 1,
      cursor: decodeCursor(options.cursor),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.lastMessageAt, last.id) : null,
      hasMore,
    };
  }

  async readThread(
    enterpriseId: number,
    conversationRefId: string,
    limit: number,
    beforeId: number | null,
  ): Promise<{ conversation: ConversationRow; messages: unknown[] }> {
    const conversation = await this.requireConversation(enterpriseId, conversationRefId);
    const messages = await this.messages.listThread(
      enterpriseId,
      conversation.id,
      clampLimit(limit),
      beforeId,
    );
    return { conversation, messages };
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
    );

    if (conversation.status === ConversationStatus.Archived) {
      throw new AppException(ErrorCode.ConversationClosed);
    }

    // An idempotent retry returns the ORIGINAL result rather than a 409: the
    // caller asked for one message and got one message.
    if (input.idempotencyKey) {
      const existing = await this.messages.findByIdempotencyKey(
        actor.enterpriseId,
        input.idempotencyKey,
      );
      if (existing) return { messageRefId: existing.refId, status: existing.status };
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

    return this.tx.runInTransaction(async () => {
      const message = await this.messages.insertOutbound({
        enterpriseId: actor.enterpriseId,
        conversationId: conversation.id,
        customerId: conversation.customerId,
        sentByEmployeeId: employeeId,
        body: input.body,
        messageKind: MessageKind.Text,
        idempotencyKey: input.idempotencyKey,
        parentMessageId: null,
        isInternalNote: input.internalNote,
      });

      if (!input.internalNote) {
        const eventType =
          conversation.conversationKind === ConversationKind.CommentThread
            ? OutboundEventType.CommentReply
            : OutboundEventType.DirectMessage;

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
            eventType === OutboundEventType.CommentReply
              ? { commentId: stripThreadPrefix(conversation.platformThreadId), message: input.body }
              : { message: input.body },
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

  async assign(
    enterpriseId: number,
    conversationRefId: string,
    employeeId: number | null,
  ): Promise<void> {
    const conversation = await this.requireConversation(enterpriseId, conversationRefId);
    await this.conversations.assign(enterpriseId, conversation.id, employeeId);
  }

  async setStatus(
    enterpriseId: number,
    conversationRefId: string,
    status: ConversationStatus,
  ): Promise<void> {
    const conversation = await this.requireConversation(enterpriseId, conversationRefId);
    await this.conversations.setStatus(enterpriseId, conversation.id, status);
  }

  async markRead(enterpriseId: number, conversationRefId: string): Promise<void> {
    const conversation = await this.requireConversation(enterpriseId, conversationRefId);
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
  private async requireConversation(
    enterpriseId: number,
    conversationRefId: string,
  ): Promise<ConversationRow> {
    const conversation = await this.conversations.findByRefId(enterpriseId, conversationRefId);
    if (!conversation) throw new AppException(ErrorCode.ConversationNotFound);
    return conversation;
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

/** The cursor carries the sort key AND the id, so pagination is deterministic. */
function encodeCursor(lastMessageAt: Date | null, id: number): string {
  return Buffer.from(JSON.stringify({ t: lastMessageAt?.toISOString() ?? null, i: id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string | null): { lastMessageAt: Date | null; id: number } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t: string | null;
      i: number;
    };
    if (typeof parsed.i !== 'number') return null;
    return { lastMessageAt: parsed.t ? new Date(parsed.t) : null, id: parsed.i };
  } catch {
    // A malformed cursor restarts from the top rather than erroring: it is
    // opaque to clients, so there is nothing useful to tell them.
    return null;
  }
}

/** `comment:123` -> `123`. The prefix is ours; the platform never sees it. */
function stripThreadPrefix(platformThreadId: string): string {
  const separator = platformThreadId.indexOf(':');
  return separator === -1 ? platformThreadId : platformThreadId.slice(separator + 1);
}
