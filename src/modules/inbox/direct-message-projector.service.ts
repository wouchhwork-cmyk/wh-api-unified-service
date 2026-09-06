import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  ConversationRepository,
  composeThreadKey,
} from '@/database/repositories/conversation.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { MessageAttachmentRepository } from '@/database/repositories/message-attachment.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { TransactionManager } from '@/database/transaction';
import {
  ConversationKind,
  CustomerFirstSource,
  IdentifierKind,
  IdentifierSource,
  IdentifierVerificationStatus,
  Platform,
  SyncJobKind,
  SyncTriggerKind,
} from '@/shared/enums';
import type { ProjectionOutcome } from './comment-projector.service';
import { normalizeAttachments, type PlatformAttachment } from './attachment-normalizer';
import { normalizeOptionalText } from '@/shared/utils/normalize';

/** Meta's messaging entry shape. */
interface MessagingEvent {
  readonly sender?: {
    readonly id?: string;
    /**
     * Present only on a BACKFILLED event, where the participants edge supplied
     * it. A live messaging webhook carries no name, which is why a customer
     * first seen through a direct message used to have none at all.
     */
    readonly name?: string;
    /**
     * Also backfill-only, and also absent from a live webhook. An Instagram
     * handle is a SECOND IDENTIFIER, not a label: it is how a person is
     * addressed and searched for.
     */
    readonly username?: string;
  };
  readonly recipient?: { readonly id?: string };
  /** Set only by the backfill: this event was reconstructed, not delivered. */
  readonly recovered?: boolean;
  /**
   * The customer put an emoji on one of our messages, or took it off.
   * `reaction` is Meta's name for it ("love"), `emoji` the character.
   */
  readonly reaction?: {
    readonly mid?: string;
    readonly action?: 'react' | 'unreact';
    readonly reaction?: string;
    readonly emoji?: string;
  };
  /**
   * The customer has SEEN a message. Instagram names the message; Messenger
   * sends a watermark instead, which is why only `mid` is read here.
   */
  readonly read?: { readonly mid?: string };
  readonly timestamp?: number;
  readonly message?: {
    readonly mid?: string;
    readonly text?: string;
    readonly is_echo?: boolean;
    readonly is_unsupported?: boolean;
    /** The customer unsent it. The row stays; the marker records what happened. */
    readonly is_deleted?: boolean;
    readonly attachments?: readonly PlatformAttachment[];
    /**
     * What this message answers. `mid` is another message of ours; `story` is
     * set when the customer replied to one of OUR stories, which is a different
     * event from being mentioned in theirs.
     */
    readonly reply_to?: {
      readonly mid?: string;
      /** True when they answered their OWN earlier message, not ours. */
      readonly is_self_reply?: boolean;
      readonly story?: { readonly url?: string; readonly id?: string };
    };
    /** The button the customer tapped, if they tapped one. */
    readonly quick_reply?: { readonly payload?: string };
  };
  /**
   * Meta's edit notification. It arrives about a second after most attachment
   * messages as a harmless duplicate — and occasionally INSTEAD of the message,
   * which is the only evidence we ever get that a delivery was lost.
   */
  readonly message_edit?: { readonly mid?: string; readonly num_edit?: number };
  /** How the customer arrived — an ad, an ig link, a ref parameter. */
  readonly referral?: {
    readonly ref?: string;
    readonly source?: string;
    readonly type?: string;
    readonly ad_id?: string;
  };
}

@Injectable()
export class DirectMessageProjectorService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly attachments: MessageAttachmentRepository,
    private readonly syncJobs: SyncJobRepository,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(DirectMessageProjectorService.name) private readonly logger: PinoLogger,
  ) {}

  async project(
    enterpriseId: number,
    channelId: number,
    platform: Platform,
    inboundEventId: number,
    payload: unknown,
  ): Promise<ProjectionOutcome> {
    const event = payload as MessagingEvent;
    const message = event.message;

    if (event.message_edit?.mid) {
      return this.handleMessageEdit(enterpriseId, channelId, event);
    }

    /*
     * Three events that are ABOUT a message rather than being one. Each names a
     * mid, so without these branches they fall through to the projection path
     * below and an unsend in particular would be stored as a new empty message.
     */
    if (event.reaction?.mid) return this.handleReaction(enterpriseId, event);
    if (event.read?.mid) return this.handleRead(enterpriseId, event);
    if (message?.mid && message.is_deleted === true) {
      return this.handleUnsend(enterpriseId, message.mid, event);
    }

    if (!message?.mid) return { projected: false, reason: 'the event carries no message id' };
    // Same reason as above: capture what the guard proved, for use in the closure.
    const platformMessageId = message.mid;

    /*
     * is_echo marks a message the PAGE sent — Meta echoes our own sends back.
     * Projecting it would duplicate the outbound row the reply flow already
     * created, and would attribute our own words to the customer.
     */
    if (message.is_echo === true) {
      /*
       * WHETHER WE ALREADY HOLD IT, not whether the event was live.
       *
       * The first rule here was "live echoes are ours, recovered ones are not",
       * and it was wrong in the case that matters most: a reply typed in the
       * INSTAGRAM APP is echoed live, the portal never sent it, and there is no
       * row anywhere — so both of a business's own replies were discarded and
       * the thread read as a monologue. Observed on live traffic.
       *
       * What actually distinguishes them is possession, which projectOwnMessage
       * checks directly.
       */
      return this.projectOwnMessage(enterpriseId, channelId, platform, inboundEventId, event);
    }

    const senderId = event.sender?.id;
    if (!senderId) return { projected: false, reason: 'the message names no sender' };

    /*
     * The attachment IS the message for a story mention, so this has to happen
     * before anything is written. It also decides the message kind, which used
     * to be "image if there are any attachments at all".
     */
    const media = normalizeAttachments(message.attachments);

    /*
     * Platform facts with no column of their own.
     *
     * Kept deliberately: each one is the raw material for a feature that does
     * not exist yet — threading a reply to its parent, attributing a
     * conversation to the ad that started it, showing which story a customer
     * was answering — and none of it is recoverable once the ledger row ages
     * out. Storing it costs a few bytes on a row we are already writing.
     */
    const platformFacts: Record<string, unknown> = {};
    if (media.isStoryMention) platformFacts.isStoryMention = true;
    if (message.reply_to?.mid) platformFacts.replyToPlatformMessageId = message.reply_to.mid;
    // The platform's own word for it. Derivable from the parent's direction —
    // but only while we hold the parent, and a lost delivery is exactly when we
    // do not.
    if (message.reply_to?.is_self_reply !== undefined) {
      platformFacts.replyIsSelfReply = message.reply_to.is_self_reply;
    }
    if (message.reply_to?.story?.id) platformFacts.replyToStoryId = message.reply_to.story.id;
    if (message.reply_to?.story?.url) platformFacts.replyToStoryUrl = message.reply_to.story.url;
    if (message.quick_reply?.payload) platformFacts.quickReplyPayload = message.quick_reply.payload;
    if (message.is_unsupported === true) platformFacts.isUnsupported = true;
    if (event.referral) platformFacts.referral = event.referral;

    const identifierKind =
      platform === Platform.Instagram
        ? IdentifierKind.InstagramUserId
        : IdentifierKind.FacebookUserId;

    return this.tx.runInTransaction(async () => {
      const customer = await this.customers.resolveOrCreate({
        enterpriseId,
        identifierKind,
        identifierValue: senderId,
        identifierValueRaw: senderId,
        displayName: normalizeOptionalText(event.sender?.name ?? null),
        firstSource:
          platform === Platform.Instagram
            ? CustomerFirstSource.InstagramDm
            : CustomerFirstSource.FacebookDm,
        firstChannelId: channelId,
        source: IdentifierSource.Platform,
        verificationStatus: IdentifierVerificationStatus.Verified,
      });

      /*
       * A NEW customer from a live webhook has NO NAME, and never will without
       * asking for one: Instagram's messaging payload carries a scoped id and
       * nothing else, so the inbox shows "Unnamed customer" for someone whose
       * handle Meta will hand over for a single API call. The conversations
       * edge returns participants{id,name,username}, which is the same call the
       * resync already makes.
       *
       * Only on CREATION, so this is one request per person rather than one per
       * message — and enqueueIfAbsent collapses a burst into a single job.
       */
      if (customer.created && !event.sender?.name && !event.sender?.username) {
        await this.syncJobs.enqueueIfAbsent({
          enterpriseId,
          channelId,
          jobKind: SyncJobKind.ResyncConversation,
          triggerKind: SyncTriggerKind.Scheduled,
          targetPlatformId: senderId,
        });
      }

      /*
       * The handle goes in customer_identifiers, next to the numeric id, rather
       * than only into display_name. It arrives only on a backfilled or
       * resynced event — a live webhook has no name and no handle — and the
       * backfill cannot store it itself, because at the moment it walks the
       * participants this customer does not exist yet. resolveOrCreate above is
       * the first point at which there is anything to attach it to.
       */
      if (platform === Platform.Instagram && event.sender?.username) {
        await this.customers.linkIdentifier({
          enterpriseId,
          customerId: customer.customerId,
          identifierKind: IdentifierKind.InstagramUsername,
          identifierValue: event.sender.username,
        });
      }

      /*
       * The DM thread key is the SENDER's scoped id, not the message id: every
       * message from this person belongs to one conversation. Meta gives no
       * conversation id on the messaging webhook, so this is the derived key.
       */
      const conversation = await this.conversations.upsert({
        enterpriseId,
        channelId,
        customerId: customer.customerId,
        customerIdentifierId: customer.identifierId,
        postId: null,
        platform,
        conversationKind: ConversationKind.DirectMessage,
        platformThreadId: composeThreadKey(ConversationKind.DirectMessage, senderId),
        subject: null,
      });

      /*
       * WHAT THIS REPLIES TO. Instagram lets somebody answer one specific
       * message, and `reply_to.mid` names it — our own outbound reply, usually.
       * parent_message_id existed and nothing ever filled it, so a threaded
       * reply was stored as a loose message and the inbox could not draw the
       * exchange the way the customer sees it.
       *
       * Null when we do not hold the parent — a reply to a message whose
       * delivery was lost, or one older than anything we keep. The platform id
       * stays in metadata either way, so the link can be made later without
       * asking Meta again.
       */
      const parentMessageId = message.reply_to?.mid
        ? await this.messages.findIdByPlatformMessageId(enterpriseId, message.reply_to.mid)
        : null;

      const inserted = await this.messages.insertInbound({
        enterpriseId,
        conversationId: conversation.id,
        customerId: customer.customerId,
        inboundEventId,
        platformMessageId,
        messageKind: media.messageKind,
        body: message.text ?? null,
        platformSentAt: event.timestamp ? new Date(event.timestamp) : null,
        parentMessageId,
        hasAttachments: media.attachments.length > 0,
        metadata: platformFacts,
      });

      if (!inserted) return { projected: false, reason: 'the message was already projected' };

      /*
       * Replies that landed before this one now point at it. A recovered thread
       * arrives newest-first, so every reply in it is stored before its parent
       * — resolving only downwards would leave all of them saying "a message we
       * never received" about a message sitting two rows below.
       */
      const adopted = await this.messages.adoptOrphanReplies(
        enterpriseId,
        inserted.id,
        platformMessageId,
      );
      if (adopted > 0) {
        this.logger.debug({ enterpriseId, adopted }, 'linked replies waiting on this message');
      }

      /*
       * Written INSIDE the projection transaction: a message row claiming
       * has_attachments with no attachment rows behind it would be a lie the
       * thread endpoint renders as an empty bubble.
       */
      if (media.attachments.length > 0) {
        await this.attachments.insertMany(
          media.attachments.map((attachment) => ({
            enterpriseId,
            messageId: inserted.id,
            mediaKind: attachment.mediaKind,
            sourceUrl: attachment.sourceUrl,
            sortOrder: attachment.sortOrder,
            metadata: attachment.metadata,
          })),
        );
      }

      const occurredAt = event.timestamp ? new Date(event.timestamp) : new Date();
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

      this.logger.debug(
        { enterpriseId, conversationId: conversation.id, newCustomer: customer.created },
        'direct message projected',
      );
      return { projected: true };
    });
  }

  /**
   * A `message_edit` notification.
   *
   * Meta sends one about a second after most attachment messages, naming a
   * message id we already hold — a duplicate, and nothing to do. But sometimes
   * it sends the edit and never sends the message: observed on live traffic on
   * 2026-09-05, when a sticker arrived only as an edit for an id that had never
   * been delivered, so the sticker simply did not exist in the inbox and nothing
   * anywhere said so.
   *
   * That unknown id is the ONLY signal a webhook was lost, so it is used as one:
   * the customer's thread is queued for a re-read from the platform. Not
   * projected here — the edit carries no sender name, no text and no attachment,
   * so there is nothing to store; the resync fetches the real message.
   *
   * enqueueIfAbsent dedups on (channel, kind, target), so a burst of edits for
   * one person queues one job.
   */
  /**
   * Stores a message the BUSINESS sent, recovered from the platform.
   *
   * The mirror image of the inbound path: on an echo the sender is us and the
   * recipient is the customer, so the thread is keyed on `recipient.id`. The
   * customer is resolved rather than created where possible — a thread we are
   * recovering almost always has one already.
   */
  private async projectOwnMessage(
    enterpriseId: number,
    channelId: number,
    platform: Platform,
    inboundEventId: number,
    event: MessagingEvent,
  ): Promise<ProjectionOutcome> {
    const message = event.message;
    const platformMessageId = message?.mid;
    if (!platformMessageId) return { projected: false, reason: 'the event carries no message id' };

    const customerScopedId = event.recipient?.id;
    if (!customerScopedId) {
      return { projected: false, reason: 'our own message names no recipient' };
    }

    const identifierKind =
      platform === Platform.Instagram
        ? IdentifierKind.InstagramUserId
        : IdentifierKind.FacebookUserId;

    const media = normalizeAttachments(message?.attachments);

    return this.tx.runInTransaction(async () => {
      const customer = await this.customers.resolveOrCreate({
        enterpriseId,
        identifierKind,
        identifierValue: customerScopedId,
        identifierValueRaw: customerScopedId,
        displayName: null,
        firstSource:
          platform === Platform.Instagram
            ? CustomerFirstSource.InstagramDm
            : CustomerFirstSource.FacebookDm,
        firstChannelId: channelId,
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
        conversationKind: ConversationKind.DirectMessage,
        platformThreadId: composeThreadKey(ConversationKind.DirectMessage, customerScopedId),
        subject: null,
      });

      /*
       * Already recorded, because the portal sent it and the relay stamped the
       * platform's id on the row. Nothing to do.
       */
      if (
        (await this.messages.findIdByPlatformMessageId(enterpriseId, platformMessageId)) !== null
      ) {
        return { projected: false, reason: 'an echo of a message we already recorded' };
      }

      /*
       * Or the portal sent it and the echo BEAT the relay's own record of the
       * platform id. Stamping the pending row is the right outcome twice over:
       * no duplicate, and the row gains the id it was waiting for — which is
       * also what lets a customer reply to it be threaded.
       */
      const claimed = await this.messages.claimPendingOutbound(
        enterpriseId,
        conversation.id,
        message?.text ?? null,
        platformMessageId,
      );
      if (claimed !== null) {
        await this.messages.adoptOrphanReplies(enterpriseId, claimed, platformMessageId);
        return {
          projected: false,
          reason: 'an echo of a send still in flight; its id is recorded',
        };
      }

      const inserted = await this.messages.insertRecoveredOutbound({
        enterpriseId,
        conversationId: conversation.id,
        customerId: customer.customerId,
        inboundEventId,
        platformMessageId,
        messageKind: media.messageKind,
        body: message?.text ?? null,
        platformSentAt: event.timestamp ? new Date(event.timestamp) : null,
        hasAttachments: media.attachments.length > 0,
        metadata: { recoveredFromPlatform: true },
      });

      // Lost a race with another worker projecting the same echo.
      if (!inserted) return { projected: false, reason: 'our own message was already recorded' };

      if (media.attachments.length > 0) {
        await this.attachments.insertMany(
          media.attachments.map((attachment) => ({
            enterpriseId,
            messageId: inserted.id,
            mediaKind: attachment.mediaKind,
            sourceUrl: attachment.sourceUrl,
            sortOrder: attachment.sortOrder,
            metadata: attachment.metadata,
          })),
        );
      }

      // The customer's replies to this message have been waiting for it.
      await this.messages.adoptOrphanReplies(enterpriseId, inserted.id, platformMessageId);

      await this.conversations.recordMessage({
        enterpriseId,
        conversationId: conversation.id,
        // NOT inbound: this must not move last_inbound_at, which is what the
        // 24-hour messaging window is measured from.
        inbound: false,
        occurredAt: event.timestamp ? new Date(event.timestamp) : new Date(),
      });

      return { projected: true };
    });
  }

  /**
   * An emoji put on one of our messages, or taken off.
   *
   * Not projected as a message: it is a property OF one, and a thread that
   * showed "❤️" as its own line would misrepresent the conversation.
   */
  private async handleReaction(
    enterpriseId: number,
    event: MessagingEvent,
  ): Promise<ProjectionOutcome> {
    const mid = event.reaction?.mid;
    if (!mid) return { projected: false, reason: 'the reaction names no message' };

    const removing = event.reaction?.action === 'unreact';
    const applied = await this.messages.applyReaction(
      enterpriseId,
      mid,
      removing
        ? null
        : {
            emoji: event.reaction?.emoji ?? null,
            name: event.reaction?.reaction ?? null,
            at: event.timestamp ? new Date(event.timestamp) : new Date(),
          },
    );

    /*
     * Not an error when we do not hold it. Instagram will return only the
     * twenty most recent messages of a thread, so a reaction to something older
     * has nothing here to attach to and never will.
     */
    if (!applied) {
      return { projected: false, reason: 'a reaction to a message we do not hold' };
    }
    return { projected: false, reason: removing ? 'a reaction removed' : 'a reaction recorded' };
  }

  /**
   * The customer has read one of our messages.
   */
  private async handleRead(
    enterpriseId: number,
    event: MessagingEvent,
  ): Promise<ProjectionOutcome> {
    const mid = event.read?.mid;
    if (!mid) return { projected: false, reason: 'the read receipt names no message' };

    const marked = await this.messages.markSeenByCustomer(
      enterpriseId,
      mid,
      event.timestamp ? new Date(event.timestamp) : new Date(),
    );
    return {
      projected: false,
      reason: marked > 0 ? `${marked} message(s) marked as seen` : 'a read receipt we cannot place',
    };
  }

  /**
   * The customer unsent a message.
   *
   * THE ROW IS KEPT AND STAYS VISIBLE, with the body intact. Erasing it would
   * change a conversation the business is accountable for underneath whoever
   * handled it — somebody can unsend an insult or a commitment, and the record
   * of what was actually said would silently differ from what happened. The
   * marker says the platform no longer shows it.
   */
  private async handleUnsend(
    enterpriseId: number,
    mid: string,
    event: MessagingEvent,
  ): Promise<ProjectionOutcome> {
    const marked = await this.messages.markDeletedOnPlatform(
      enterpriseId,
      mid,
      event.timestamp ? new Date(event.timestamp) : new Date(),
    );
    return {
      projected: false,
      reason: marked
        ? 'the customer unsent this message; the record is kept'
        : 'an unsend for a message we do not hold',
    };
  }

  private async handleMessageEdit(
    enterpriseId: number,
    channelId: number,
    event: MessagingEvent,
  ): Promise<ProjectionOutcome> {
    const mid = event.message_edit?.mid;
    if (!mid) return { projected: false, reason: 'the event carries no message id' };

    if ((await this.messages.findIdByPlatformMessageId(enterpriseId, mid)) !== null) {
      return { projected: false, reason: 'a message_edit for a message we already hold' };
    }

    const senderId = event.sender?.id;
    if (!senderId) {
      return { projected: false, reason: 'a message_edit for an unknown message, with no sender' };
    }

    const queued = await this.syncJobs.enqueueIfAbsent({
      enterpriseId,
      channelId,
      jobKind: SyncJobKind.ResyncConversation,
      triggerKind: SyncTriggerKind.Scheduled,
      targetPlatformId: senderId,
    });

    this.logger.warn(
      { enterpriseId, channelId, queued },
      'a message_edit named a message we never received — the delivery was lost, resync queued',
    );

    return {
      projected: false,
      reason: queued
        ? 'a message_edit for a message we never received — resync queued'
        : 'a message_edit for a message we never received — a resync is already in flight',
    };
  }
}
