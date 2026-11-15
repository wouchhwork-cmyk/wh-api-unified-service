import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { AuditService } from '@/modules/audit/audit.service';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { ChatService } from '@/modules/ai/chat.service';
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
  /** The draft could not be produced, so the customer got the fallback. */
  Failed: 'could_not_answer',
  /** Its media is still being described; the real answer follows. */
  WaitingForMedia: 'waiting_for_media',
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
      /*
       * AND IT LEAVES A ROW. The first automatic reply ever attempted died
       * here — a worker has no actor, so the thread read refused with
       * "conversation not found" — and the only trace was a log line in a
       * process nobody was watching. A customer was left unanswered by a
       * feature that had been switched on, and the audit trail said nothing
       * at all. An unexpected failure is exactly the kind somebody needs to
       * find afterwards.
       *
       * The message is recorded, never the conversation: a stack can quote
       * the input back, and the input here is somebody's message.
       */
      await this.record(enterpriseId, messageId, AuditStatus.Error, {
        failed: error instanceof Error ? error.message : 'automatic reply failed',
      }).catch(() => {
        /* An audit write that fails must not become the thing that throws
         * into ingest. The log above already carries it. */
      });
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
    const context = await this.messages.assistantContextFor(enterpriseId, messageId);
    if (!context) return this.skipQuietly(enterpriseId, messageId, Skip.Gone);

    if (!this.chat.enabledFor(settings.provider)) {
      /*
       * A fault rather than a preference: somebody turned this on and expects
       * it to work. The customer still hears something, because from where
       * they are sitting a missing API key and a broken model are the same
       * silence.
       */
      await this.record(enterpriseId, messageId, AuditStatus.Failure, {
        skipped: Skip.NoProvider,
        provider: settings.provider,
      });
      await this.sendFallback(enterpriseId, messageId, context.conversationRefId, settings, null);
      return;
    }

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

    /*
     * ITS PHOTO HAS NOT BEEN LOOKED AT YET.
     *
     * Media is described by a worker seconds after the message lands, so a
     * photo sent with no text reaches this before there is anything to
     * answer about — the first real one failed with "the model returned no
     * text" and apologised, for a message that was about to be perfectly
     * answerable. Hold the moment instead, and the analysis worker brings us
     * back when the description exists.
     */
    if (context.pendingMedia > 0) {
      await this.sendHold(enterpriseId, messageId, context.conversationRefId, settings);
      return;
    }

    /* The actorless read: a worker has no employee whose permissions to check. */
    let draft;
    try {
      draft = await this.chatbot.draftReplyForAutomation(enterpriseId, context.conversationRefId);
    } catch (error) {
      /*
       * THE CUSTOMER IS NOT LEFT IN SILENCE. Every fast answer before this
       * one has told them somebody is there, so a model failure that says
       * nothing reads as being ignored — which is worse than never having
       * answered quickly at all. They get a short human line instead, and
       * the real reason goes to the trail rather than to them.
       */
      await this.sendFallback(enterpriseId, messageId, context.conversationRefId, settings, error);
      return;
    }

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
   * A piece of media has just been described: anything that was waiting on it
   * can be answered now.
   *
   * Called from the analysis worker rather than from the analyser itself,
   * for the reason the projector's call is at the worker too — the service
   * that describes media lives in a module the inbox depends on, and the
   * worker is where the two can meet without a cycle.
   *
   * EVERY GUARD RUNS AGAIN. By the time a description lands, a colleague may
   * have answered, the customer may have said something else, or the thread
   * may have been closed. This is a second consideration, not a deferred
   * decision taken earlier.
   */
  async onMediaDescribed(enterpriseId: number, mediaKey: string): Promise<void> {
    try {
      const waiting = await this.messages.messagesCarrying(enterpriseId, mediaKey);
      for (const messageId of waiting) {
        await this.considerReplying(enterpriseId, messageId);
      }
    } catch (error) {
      this.logger.error(
        { err: error, enterpriseId, mediaKey },
        'could not resume automatic replies after describing media',
      );
    }
  }

  /**
   * "Let me take a look at that."
   *
   * ITS OWN IDEMPOTENCY KEY, so the hold is said once however many times
   * this message is considered — a second piece of media finishing, a
   * redelivered webhook, a retried projection. The real answer uses the
   * reply key, which this never touches.
   *
   * SILENT WHEN THE TEXT IS EMPTY: a business may prefer to say nothing and
   * answer once, properly, a few seconds later.
   */
  private async sendHold(
    enterpriseId: number,
    messageId: number,
    conversationRefId: string,
    settings: { mediaHoldMessage: string },
  ): Promise<void> {
    const text = settings.mediaHoldMessage.trim();
    if (text.length > 0) {
      try {
        await this.inbox.replyAsAssistant(enterpriseId, {
          conversationRefId,
          body: text,
          idempotencyKey: `assistant-hold:${messageId}`,
          internalNote: false,
          assistant: { hold: true, inReplyToMessageId: messageId },
        });
      } catch (error) {
        /* The real answer is still coming; a failed holding line is not worth
         * losing it over. */
        this.logger.warn(
          { err: error, enterpriseId, conversationRefId },
          'could not send the holding message while media is described',
        );
      }
    }

    await this.record(enterpriseId, messageId, AuditStatus.Failure, {
      skipped: Skip.WaitingForMedia,
      holdSent: text.length > 0,
      conversationRefId,
    });
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
  /**
   * The apology, when there is no answer to send.
   *
   * ITS OWN IDEMPOTENCY KEY, distinct from the reply's, so a redelivered
   * webhook cannot apologise twice — and so a later successful reply to the
   * same message is still possible, rather than being swallowed by a key an
   * apology already used.
   *
   * SILENT WHEN THE TEXT IS EMPTY. A business that would rather say nothing
   * than send an apology it did not write has made a choice, and this
   * respects it.
   *
   * IT NEVER RAISES. This runs because something already went wrong; a
   * failure here would replace a recorded fault with an unrecorded one.
   */
  private async sendFallback(
    enterpriseId: number,
    messageId: number,
    conversationRefId: string,
    settings: { fallbackMessage: string },
    cause: unknown,
  ): Promise<void> {
    const reason = cause instanceof Error ? cause.message : null;
    const text = settings.fallbackMessage.trim();

    if (text.length === 0) {
      await this.record(enterpriseId, messageId, AuditStatus.Failure, {
        skipped: Skip.Failed,
        fallbackSent: false,
        ...(reason ? { failed: reason } : {}),
      });
      return;
    }

    try {
      const sent = await this.inbox.replyAsAssistant(enterpriseId, {
        conversationRefId,
        body: text,
        idempotencyKey: `assistant-fallback:${messageId}`,
        internalNote: false,
        assistant: { fallback: true, inReplyToMessageId: messageId },
      });
      await this.record(enterpriseId, messageId, AuditStatus.Failure, {
        skipped: Skip.Failed,
        fallbackSent: true,
        messageRefId: sent.messageRefId,
        ...(reason ? { failed: reason } : {}),
      });
      this.logger.warn(
        { enterpriseId, conversationRefId, messageRefId: sent.messageRefId, reason },
        'assistant could not answer; sent the fallback message',
      );
    } catch (error) {
      this.logger.error(
        { err: error, enterpriseId, conversationRefId, reason },
        'assistant could not answer and the fallback could not be sent either',
      );
      await this.record(enterpriseId, messageId, AuditStatus.Error, {
        skipped: Skip.Failed,
        fallbackSent: false,
        ...(reason ? { failed: reason } : {}),
      }).catch(() => {
        /* Already the failure path; an audit write must not become the throw. */
      });
    }
  }

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
