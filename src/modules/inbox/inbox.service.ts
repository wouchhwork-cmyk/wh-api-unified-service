import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import {
  ConversationRepository,
  type ConversationRow,
} from '@/database/repositories/conversation.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import {
  MessageAttachmentRepository,
  type AttachmentRow,
} from '@/database/repositories/message-attachment.repository';
import { MessageRepository, type MessageRow } from '@/database/repositories/message.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import { TransactionManager } from '@/database/transaction';
import { RequestContext } from '@/shared/context';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/shared/constants';
import {
  AuditAction,
  AuditEntityType,
  ConversationKind,
  ConversationStatus,
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
  ConversationKind.StoryReply,
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
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly attachments: MessageAttachmentRepository,
    private readonly syncJobs: SyncJobRepository,
    private readonly outbound: OutboundEventRepository,
    private readonly channels: ChannelRepository,
    private readonly customers: CustomerRepository,
    private readonly audit: AuditService,
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
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const conversation = await this.requireConversation(enterpriseId, conversationRefId);
    const size = clampLimit(limit);

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

    return {
      conversation,
      messages,
      attachmentsByMessageId,
      nextCursor:
        hasMore && last ? encodeKeysetCursor(last.platformSentAt ?? last.createdAt, last.id) : null,
      hasMore,
    };
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
            eventType === OutboundEventType.CommentReply
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
    employeeId: number | null,
  ): Promise<void> {
    const conversation = await this.requireConversation(enterpriseId, conversationRefId);
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
      kind: 'assigned',
    });
  }

  async setStatus(
    enterpriseId: number,
    conversationRefId: string,
    status: ConversationStatus,
  ): Promise<void> {
    const conversation = await this.requireConversation(enterpriseId, conversationRefId);
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
      kind: 'status',
    });
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
function stripThreadPrefix(platformThreadId: string): string {
  const separator = platformThreadId.indexOf(':');
  return separator === -1 ? platformThreadId : platformThreadId.slice(separator + 1);
}
