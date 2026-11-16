import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { AuditService } from '@/modules/audit/audit.service';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import {
  AssistantReplyRepository,
  type ClaimedReply,
} from '@/database/repositories/assistant-reply.repository';
import { ChatService } from '@/modules/ai/chat.service';
import { ChatError } from '@/modules/ai/chat.errors';
import { AuditAction, AuditEntityType, AuditStatus, ConversationStatus } from '@/shared/enums';
import { ASSISTANT_REPLY_MEDIA_WAIT_MS, ASSISTANT_REPLY_RETRY_BASE_MS } from '@/shared/constants';
import { ChatbotService, type DraftedReply } from './chatbot.service';
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
  /** The model read it and decided nothing needed saying. */
  NothingToSay: 'nothing_to_say',
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
 *
 * IT IS DRIVEN BY A LEDGER ROW RATHER THAN A FUNCTION CALL. It used to be
 * invoked by the projector the moment a message landed, which meant the
 * obligation to answer existed only on that worker's stack: a deploy, an OOM
 * or a `kill` between accepting the message and answering it left a customer
 * permanently unanswered, with no row anywhere saying an answer was owed and
 * not even an audit entry, because the crash landed before the line that
 * would have written one. Now the projector records the obligation and this
 * settles it — claimed, leased, retried and given up on like every other
 * piece of slow work in this service.
 *
 * IT SETTLES ITS OWN ROW ON EVERY PATH, including failure, so one bad reply
 * cannot stop a batch or leave a row leased to nobody.
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
    private readonly replies: AssistantReplyRepository,
    private readonly audit: AuditService,
    @InjectPinoLogger(AutoReplyService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * One claimed obligation, attempted and settled.
   *
   * NEVER THROWS. The worker's batch must survive a bad row, and a row left
   * leased by an escaping error is a reply nobody sends until the lease
   * reaper notices. Everything inside is already defensive; the catch exists
   * so that a bug in it still settles.
   */
  async attempt(claimed: ClaimedReply, leaseOwner: string): Promise<void> {
    try {
      await this.run(claimed, leaseOwner);
    } catch (error) {
      this.logger.error(
        { err: error, enterpriseId: claimed.enterpriseId, messageId: claimed.messageId },
        'automatic reply failed unexpectedly',
      );
      /*
       * AND IT LEAVES A ROW. The first automatic reply ever attempted died
       * here — a worker has no actor, so the thread read refused with
       * "conversation not found" — and the only trace was a log line in a
       * process nobody was watching. A customer was left unanswered by a
       * feature that had been switched on, and the audit trail said nothing
       * at all. The ledger settle below is not a substitute: that is the
       * queue's own bookkeeping, and this is the record somebody reads when
       * they ask what happened to their customer.
       *
       * The message is recorded, never the conversation: a stack can quote
       * the input back, and the input here is somebody's message.
       */
      await this.record(claimed.enterpriseId, claimed.messageId, AuditStatus.Error, {
        failed: error instanceof Error ? error.message : 'automatic reply failed',
      }).catch(() => {
        /* An audit write that fails must not stop the row being settled. */
      });

      await this.fail(claimed, leaseOwner, {
        failureCode: 'UNEXPECTED',
        reason: error instanceof Error ? error.message : 'automatic reply failed',
        permanent: false,
      }).catch(() => {
        /* An audit or a settle that fails must not escape into the batch.
         * The log above already carries it, and the lease reaper is the
         * backstop for the row. */
      });
    }
  }

  /**
   * A piece of media has just been described: anything waiting on it is due.
   *
   * A NUDGE, NOT THE MECHANISM. The row already carries its own next attempt,
   * so a description that never lands still gets looked at again — this only
   * brings it forward to the second the description exists, which is the
   * difference between answering a photo now and answering it at the next
   * tick. A crash here costs latency rather than the reply.
   */
  async onMediaDescribed(enterpriseId: number, mediaKey: string): Promise<void> {
    try {
      const waiting = await this.messages.messagesCarrying(enterpriseId, mediaKey);
      const woken = await this.replies.wake(enterpriseId, waiting);
      if (woken > 0) {
        this.logger.debug(
          { enterpriseId, mediaKey, woken },
          'brought owed replies forward after describing media',
        );
      }
    } catch (error) {
      this.logger.error(
        { err: error, enterpriseId, mediaKey },
        'could not bring owed replies forward after describing media',
      );
    }
  }

  private async run(claimed: ClaimedReply, leaseOwner: string): Promise<void> {
    const { enterpriseId, messageId } = claimed;

    /*
     * THE TWO SWITCHES FIRST, because they are the cheap reads and they are
     * off for almost everybody. Nothing else is worth doing until both say
     * yes — least of all a paid model call.
     */
    const settings = await this.chat.currentSettings();
    if (!settings.autoReply) {
      return this.skipQuietly(claimed, leaseOwner, Skip.PlatformOff);
    }

    const enterprise = await this.enterprises.findById(enterpriseId);
    if (!enterprise?.autoReplyEnabled) {
      return this.skipQuietly(claimed, leaseOwner, Skip.BusinessOff);
    }

    const context = await this.messages.assistantContextFor(enterpriseId, messageId);
    if (!context) return this.skipQuietly(claimed, leaseOwner, Skip.Gone);

    if (!(await this.chat.enabledFor(settings.provider))) {
      /*
       * A fault rather than a preference: somebody turned this on and expects
       * it to work. The customer still hears something, because from where
       * they are sitting a missing API key and a broken model are the same
       * silence. Terminal: a key added an hour from now should not produce an
       * answer to an hour-old message on top of the apology already sent.
       */
      await this.record(enterpriseId, messageId, AuditStatus.Failure, {
        skipped: Skip.NoProvider,
        provider: settings.provider,
      });
      await this.sendFallback(enterpriseId, messageId, context.conversationRefId, settings, null);
      await this.replies.markFailed(claimed.id, leaseOwner, {
        failureCode: Skip.NoProvider,
        failureReason: `no key for ${settings.provider}`,
        permanent: true,
        backoffMs: 0,
      });
      return;
    }

    if (
      context.status === ConversationStatus.Closed ||
      context.status === ConversationStatus.Archived
    ) {
      await this.record(enterpriseId, messageId, AuditStatus.Failure, {
        skipped: Skip.Closed,
        conversationRefId: context.conversationRefId,
      });
      await this.replies.markSkipped(claimed.id, leaseOwner, Skip.Closed);
      return;
    }

    /*
     * SOMEBODY ELSE GOT THERE FIRST. An agent may have answered while this
     * was queued, or the customer may have sent three more messages. Either
     * way this message is no longer the end of the conversation, and
     * answering it now would be answering a question that has moved on. The
     * newest message has an obligation of its own.
     */
    if (context.messagesSince > 0) {
      await this.record(enterpriseId, messageId, AuditStatus.Failure, {
        skipped: Skip.Overtaken,
        messagesSince: context.messagesSince,
        conversationRefId: context.conversationRefId,
      });
      await this.replies.markSkipped(claimed.id, leaseOwner, Skip.Overtaken);
      return;
    }

    /*
     * ITS PHOTO HAS NOT BEEN LOOKED AT YET.
     *
     * Media is described by a worker seconds after the message lands, so a
     * photo sent with no text reaches this before there is anything to
     * answer about. Hold the moment with a line, put the row back WITHOUT
     * spending an attempt, and let the analysis worker bring it forward the
     * moment the description exists.
     */
    if (context.pendingMedia > 0) {
      await this.sendHold(enterpriseId, messageId, context.conversationRefId, settings);
      await this.replies.defer(claimed.id, leaseOwner, ASSISTANT_REPLY_MEDIA_WAIT_MS);
      return;
    }

    /* The actorless read: a worker has no employee whose permissions to check. */
    let draft: DraftedReply;
    try {
      draft = await this.chatbot.draftReplyForAutomation(enterpriseId, context.conversationRefId);
    } catch (error) {
      await this.failedToDraft(claimed, leaseOwner, context.conversationRefId, settings, error);
      return;
    }

    /*
     * IT READ THE MESSAGE AND DECIDED NOT TO ANSWER IT.
     *
     * "ok", "thanks", a thumbs-up — a person reading an inbox does not reply
     * to those, and an assistant that does is the most recognisable tell
     * there is that nobody is home. The decision is the model's rather than
     * a rule here, because "nothing needs saying" depends entirely on what
     * was being said: the same "ok" ends one exchange and agrees to a
     * delivery slot in another.
     */
    if (draft.silent) {
      await this.record(enterpriseId, messageId, AuditStatus.Success, {
        skipped: Skip.NothingToSay,
        conversationRefId: context.conversationRefId,
        ...(draft.intent ? { intent: draft.intent } : {}),
        usage: draft.usage,
      });
      await this.replies.markSkipped(claimed.id, leaseOwner, Skip.NothingToSay);
      return;
    }

    /*
     * NOTHING TO SEND, WHICH IS NOT THE SAME AS CHOOSING NOT TO. A model that
     * answered with an envelope and no message in it has failed, and failing
     * quietly here would look exactly like the deliberate silence above.
     */
    if (draft.text.trim().length === 0) {
      await this.failedToDraft(
        claimed,
        leaseOwner,
        context.conversationRefId,
        settings,
        new ChatError('CHAT_NO_REPLY', 'the model produced no message to send', true),
      );
      return;
    }

    /*
     * ASK AGAIN BEFORE SENDING IT.
     *
     * The draft took seconds, and a customer can say three more things in
     * that time. The check before drafting proves the question was current
     * when we started; only this one proves the ANSWER is still current when
     * it goes. The draft is thrown away rather than sent: it is already paid
     * for, and sending it would compound a wasted call with a confusing
     * message.
     */
    const current = await this.messages.assistantContextFor(enterpriseId, messageId);
    if (!current || current.messagesSince > 0) {
      await this.record(enterpriseId, messageId, AuditStatus.Failure, {
        skipped: Skip.Overtaken,
        messagesSince: current?.messagesSince ?? null,
        draftDiscarded: true,
        conversationRefId: context.conversationRefId,
      });
      await this.replies.markSkipped(claimed.id, leaseOwner, Skip.Overtaken);
      this.logger.info(
        { enterpriseId, conversationRefId: context.conversationRefId },
        'discarded a draft: the conversation moved on while it was being written',
      );
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
      /*
       * WHAT IT UNDERSTOOD AND WHAT IT COULD NOT DO. The handoff is the
       * load-bearing one: the reply that goes with it has just told a
       * customer somebody will come back to them, and a promise nobody can
       * see is a promise nobody keeps.
       */
      ...(draft.handoff ? { handoff: draft.handoff } : {}),
      ...(draft.intent ? { intent: draft.intent } : {}),
      ...(draft.language ? { language: draft.language } : {}),
      /* A model that stopped answering in the shape it was asked for is a
       * prompt or a model to change, and that shows up here first. */
      ...(draft.structured ? {} : { unstructured: true }),
    };

    const sent = await this.inbox.replyAsAssistant(enterpriseId, {
      conversationRefId: context.conversationRefId,
      body: draft.text,
      /*
       * KEYED TO THE MESSAGE IT ANSWERS. A redelivered webhook, a retried
       * claim or a worker that restarts mid-send all arrive here again with
       * the same id — and the unique index on (enterprise_id,
       * idempotency_key) is what makes the second one return the first
       * reply instead of sending a customer the same message twice.
       */
      idempotencyKey: `assistant:${messageId}`,
      internalNote: false,
      assistant,
    });

    await this.replies.markSent(claimed.id, leaseOwner, {
      replyMessageId: null,
      provider: draft.provider,
      model: draft.model,
      promptVersion: draft.promptVersion,
      intent: draft.intent?.slice(0, 120) ?? null,
      handoffReason: draft.handoff?.slice(0, 255) ?? null,
      inputTokens: draft.usage.inputTokens,
      outputTokens: draft.usage.outputTokens,
      totalTokens: draft.usage.totalTokens,
    });

    this.logger.info(
      {
        enterpriseId,
        conversationRefId: context.conversationRefId,
        messageRefId: sent.messageRefId,
        provider: draft.provider,
        model: draft.model,
        handoff: draft.handoff,
      },
      'assistant replied automatically',
    );

    if (draft.handoff) {
      /*
       * WARN, because this one has a person waiting at the end of it. The
       * assistant has answered and said a colleague will follow up; from
       * here until somebody does, the business owes this customer something.
       */
      this.logger.warn(
        {
          enterpriseId,
          conversationRefId: context.conversationRefId,
          messageRefId: sent.messageRefId,
          reason: draft.handoff,
        },
        'assistant asked for a person to take this conversation over',
      );
    }
  }

  /**
   * The draft failed. Try again, or apologise and stop.
   *
   * THE LEDGER BOUGHT THIS. A timeout or a rate limit used to mean one
   * apology and nothing more, because there was nothing to come back to. Now
   * a retryable failure with attempts left is simply retried — a model that
   * timed out and answered thirty seconds later is far better for the
   * customer than an apology that arrived instantly. The apology is kept for
   * the last attempt and for failures that will not change, which is where it
   * was always the right answer.
   */
  private async failedToDraft(
    claimed: ClaimedReply,
    leaseOwner: string,
    conversationRefId: string,
    settings: { fallbackMessage: string },
    error: unknown,
  ): Promise<void> {
    const retryable = error instanceof ChatError ? error.retryable : false;
    const lastAttempt = claimed.attemptCount >= claimed.maxAttempts;
    const giveUp = !retryable || lastAttempt;

    if (giveUp) {
      await this.sendFallback(
        claimed.enterpriseId,
        claimed.messageId,
        conversationRefId,
        settings,
        error,
      );
    } else {
      this.logger.warn(
        {
          enterpriseId: claimed.enterpriseId,
          conversationRefId,
          attempt: claimed.attemptCount,
          reason: error instanceof Error ? error.message : null,
        },
        'could not draft a reply; will try again before apologising',
      );
    }

    await this.fail(claimed, leaseOwner, {
      failureCode: error instanceof ChatError ? error.failureCode : 'CHAT_CALL_FAILED',
      reason: error instanceof Error ? error.message.slice(0, 500) : 'the draft failed',
      permanent: giveUp,
    });
  }

  private async fail(
    claimed: ClaimedReply,
    leaseOwner: string,
    input: { failureCode: string; reason: string; permanent: boolean },
  ): Promise<void> {
    await this.replies.markFailed(claimed.id, leaseOwner, {
      failureCode: input.failureCode,
      failureReason: input.reason,
      permanent: input.permanent,
      backoffMs: ASSISTANT_REPLY_RETRY_BASE_MS * Math.max(1, claimed.attemptCount),
    });
  }

  /**
   * "Let me take a look at that."
   *
   * ITS OWN IDEMPOTENCY KEY, so the hold is said once however many times
   * this message is considered — a second piece of media finishing, a
   * redelivered webhook, a deferred row coming back round. The real answer
   * uses the reply key, which this never touches.
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
   * A skip nobody needs an audit row for.
   *
   * The switches are off for almost every message on the platform, and an
   * audit entry for each would bury the handful that describe something that
   * actually happened. The LEDGER row is still settled — that one is the
   * record that this message was considered and deliberately left alone.
   */
  private async skipQuietly(
    claimed: ClaimedReply,
    leaseOwner: string,
    reason: SkipReason,
  ): Promise<void> {
    this.logger.debug(
      { enterpriseId: claimed.enterpriseId, messageId: claimed.messageId, reason },
      'automatic reply not attempted',
    );
    await this.replies.markSkipped(claimed.id, leaseOwner, reason);
  }

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
