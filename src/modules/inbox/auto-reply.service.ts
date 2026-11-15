import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { AuditService } from '@/modules/audit/audit.service';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { ChatService } from '@/modules/ai/chat.service';
import { AUTO_REPLY_MAX_PER_WINDOW, AUTO_REPLY_WINDOW_MINUTES } from '@/shared/constants';
import { AuditAction, AuditEntityType, AuditStatus, ConversationStatus } from '@/shared/enums';
import { ChatbotService } from './chatbot.service';
import { InboxService } from './inbox.service';

/** Why an automatic reply did not happen. Recorded; never thrown. */
const Skip = {
  PlatformOff: 'platform_switch_off',
  BusinessOff: 'business_not_opted_in',
  NoProvider: 'provider_has_no_key',
  Gone: 'message_or_conversation_missing',
  Closed: 'conversation_closed',
  Overtaken: 'conversation_moved_on',
  LoopGuard: 'loop_guard',
} as const;

type SkipReason = (typeof Skip)[keyof typeof Skip];

/**
 * The assistant answering a customer by itself.
 *
 * EVERY GUARD HERE EXISTS BECAUSE THE ALTERNATIVE IS A MESSAGE TO A REAL
 * PERSON. There is no undo: a reply is sent to someone's phone, in the
 * business's name, and nothing this service does afterwards can retract it.
 * So it refuses by default and proceeds only when every one of these agrees:
 *
 *   1. the platform's switch is on          (ours, a kill switch)
 *   2. the business has opted in            (theirs, a consent)
 *   3. the provider has a key here
 *   4. the conversation is still open
 *   5. nothing has been said since          (a human may have answered first)
 *   6. the loop guard has room              (two bots is the ordinary failure)
 *
 * IT NEVER THROWS INTO INGEST. A webhook that failed because an optional
 * reply could not be drafted would lose the customer's message itself, which
 * is the thing that actually matters.
 *
 * EVERY ATTEMPT IS AUDITED — the sends and the refusals both. "Why did the
 * assistant say that to my customer" and "why did it not answer this one" are
 * the same question asked from two directions, and a trail that answers only
 * the first is no use on the day it matters.
 */
@Injectable()
export class AutoReplyService {
  constructor(
    private readonly chat: ChatService,
    private readonly chatbot: ChatbotService,
    private readonly inbox: InboxService,
    private readonly enterprises: EnterpriseRepository,
    private readonly messages: MessageRepository,
    private readonly audit: AuditService,
    @InjectPinoLogger(AutoReplyService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Considers answering one inbound message, and usually does not.
   *
   * Called AFTER the projection transaction commits, never inside it: the
   * draft is a model call and a send is an HTTP call, and neither belongs
   * inside a transaction holding row locks on a customer's conversation.
   */
  async considerReplying(enterpriseId: number, messageId: number): Promise<void> {
    try {
      await this.run(enterpriseId, messageId);
    } catch (error) {
      /*
       * The last line of defence. Everything inside `run` is already
       * defensive; this exists so that a bug in it can never cost us the
       * customer's message, which is already safely stored by now.
       */
      this.logger.error(
        { err: error, enterpriseId, messageId },
        'automatic reply failed unexpectedly',
      );
    }
  }

  private async run(enterpriseId: number, messageId: number): Promise<void> {
    /*
     * THE TWO SWITCHES FIRST, because they are the cheap reads and they are
     * off for almost everybody. Nothing else is worth doing until both say
     * yes — least of all a paid model call.
     */
    const settings = await this.chat.currentSettings();
    if (!settings.autoReply) return this.skipQuietly(enterpriseId, messageId, Skip.PlatformOff);

    const enterprise = await this.enterprises.findById(enterpriseId);
    if (!enterprise?.autoReplyEnabled) {
      return this.skipQuietly(enterpriseId, messageId, Skip.BusinessOff);
    }
    if (!this.chat.enabledFor(settings.provider)) {
      /* Audited rather than quiet: somebody turned this on and expects it to
       * work, so a missing key is a fault rather than a preference. */
      return this.record(enterpriseId, messageId, AuditStatus.Failure, {
        skipped: Skip.NoProvider,
        provider: settings.provider,
      });
    }

    const context = await this.messages.assistantContextFor(
      enterpriseId,
      messageId,
      AUTO_REPLY_WINDOW_MINUTES,
    );
    if (!context) return this.skipQuietly(enterpriseId, messageId, Skip.Gone);

    if (
      context.status === ConversationStatus.Closed ||
      context.status === ConversationStatus.Archived
    ) {
      return this.record(enterpriseId, messageId, AuditStatus.Failure, {
        skipped: Skip.Closed,
        conversationRefId: context.conversationRefId,
      });
    }

    /*
     * SOMEBODY ELSE GOT THERE FIRST. An agent may have answered while the
     * model was thinking, or the customer may have sent three more messages.
     * Either way this message is no longer the end of the conversation, and
     * answering it now would be answering a question that has moved on. The
     * newest message gets its own consideration.
     */
    if (context.messagesSince > 0) {
      return this.record(enterpriseId, messageId, AuditStatus.Failure, {
        skipped: Skip.Overtaken,
        messagesSince: context.messagesSince,
        conversationRefId: context.conversationRefId,
      });
    }

    if (context.recentAssistantReplies >= AUTO_REPLY_MAX_PER_WINDOW) {
      /*
       * LOUD, because this is the one skip that means something is wrong
       * rather than merely quiet: a conversation that hit the ceiling is
       * either a loop or a customer the assistant cannot satisfy, and both
       * want a person.
       */
      this.logger.warn(
        {
          enterpriseId,
          conversationRefId: context.conversationRefId,
          repliesInWindow: context.recentAssistantReplies,
          windowMinutes: AUTO_REPLY_WINDOW_MINUTES,
        },
        'automatic reply stopped by the loop guard',
      );
      return this.record(enterpriseId, messageId, AuditStatus.Failure, {
        skipped: Skip.LoopGuard,
        repliesInWindow: context.recentAssistantReplies,
        limit: AUTO_REPLY_MAX_PER_WINDOW,
        conversationRefId: context.conversationRefId,
      });
    }

    const draft = await this.chatbot.draftReply(enterpriseId, context.conversationRefId);

    /*
     * WHAT WROTE IT, carried into both the message row and the audit row the
     * send path writes. One object, one source: a trail that says `system`
     * without naming the model and the instruction version answers "not a
     * person" and nothing else.
     */
    const assistant = {
      provider: draft.provider,
      model: draft.model,
      promptVersion: draft.promptVersion,
      /* The message it was answering, so a reply can be traced to its cause. */
      inReplyToMessageId: messageId,
      /* What it cost, and what it was given — for the bill, and for the
       * "did it even see the photo" question. */
      usage: draft.usage,
      context: draft.context,
      truncated: draft.truncated,
    };

    const sent = await this.inbox.replyAsAssistant(enterpriseId, {
      conversationRefId: context.conversationRefId,
      body: draft.text,
      /*
       * KEYED TO THE MESSAGE IT ANSWERS. A redelivered webhook, a retried
       * projection or a worker that restarts mid-send all arrive here again
       * with the same id — and the unique index on (enterprise_id,
       * idempotency_key) is what makes the second one return the first
       * reply instead of sending a customer the same message twice.
       */
      idempotencyKey: `assistant:${messageId}`,
      internalNote: false,
      assistant,
    });

    this.logger.info(
      {
        enterpriseId,
        conversationRefId: context.conversationRefId,
        messageRefId: sent.messageRefId,
        provider: draft.provider,
        model: draft.model,
      },
      'assistant replied automatically',
    );
  }

  /**
   * A skip nobody needs a permanent record of.
   *
   * The switches are off for almost every message on the platform, and an
   * audit row for each would bury the handful that describe something that
   * actually happened. Debug-level, where it can be turned on while somebody
   * is asking why their assistant is silent.
   */
  private skipQuietly(enterpriseId: number, messageId: number, reason: SkipReason): void {
    this.logger.debug({ enterpriseId, messageId, reason }, 'automatic reply not attempted');
  }

  /**
   * The trail.
   *
   * Against the MESSAGE THAT WAS ANSWERED rather than the reply, because that
   * is the row somebody has in their hand when they ask the question — and
   * because a refusal has no reply to point at. The actor resolves to
   * `system`: there is no request context in a worker, which is the honest
   * answer about who sent this.
   */
  private async record(
    enterpriseId: number,
    messageId: number,
    status: AuditStatus,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      action: AuditAction.Replied,
      entityType: AuditEntityType.Message,
      entityId: messageId,
      enterpriseId,
      status,
      metadata: { automatic: true, ...metadata },
    });
  }
}
