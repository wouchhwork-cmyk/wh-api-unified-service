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
import { ORPHAN_EDIT_GRACE_ATTEMPTS } from '@/shared/constants';
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
  /**
   * The customer TAPPED something — an ice breaker, or a button on a template.
   *
   * We subscribe to `messaging_postbacks` and were dropping every one of them:
   * a postback carries its id at `postback.mid`, not `message.mid`, so it fell
   * through the "carries no message id" guard and was skipped in silence. The
   * customer had acted, the ledger recorded the delivery, and the inbox showed
   * nothing.
   */
  readonly postback?: {
    readonly mid?: string;
    /** What the button SAID — the customer's side of the exchange. */
    readonly title?: string;
    /** What it MEANT — ours, set when the button was defined. */
    readonly payload?: string;
  };
  /**
   * The customer opted in to something. Subscribed via `messaging_optins` and
   * likewise dropped; kept distinct from a postback because it is a consent
   * event rather than a message, and conflating them would put a row in the
   * inbox that nobody said anything in.
   */
  readonly optin?: { readonly type?: string; readonly payload?: string; readonly notification_messages_token?: string };
  /** How the customer arrived — an ad, an ig link, a ref parameter. */
  readonly referral?: {
    readonly ref?: string;
    readonly source?: string;
    readonly type?: string;
    readonly ad_id?: string;
  };
}

/**
 * A postback, in the shape the rest of this projector expects.
 *
 * The TITLE is the customer's side of it — the words they tapped — so it
 * becomes the body. The PAYLOAD is ours, set when the button was defined, and
 * travels in metadata instead: an agent reading the thread should see
 * "See menu", not `MENU_V2_EN`.
 */
function postbackAsMessage(
  postback:
    | { readonly mid?: string; readonly title?: string; readonly payload?: string }
    | undefined,
): MessagingEvent['message'] {
  if (!postback?.mid) return undefined;
  return { mid: postback.mid, ...(postback.title ? { text: postback.title } : {}) };
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
    /**
     * Which attempt this is. Only the orphan-edit path reads it, and it defaults
     * so every existing caller and test keeps working — a default of 1 means
     * "first sight", which is the conservative reading.
     */
    attemptCount = 1,
  ): Promise<ProjectionOutcome> {
    const event = payload as MessagingEvent;
    /*
     * A TAP IS A MESSAGE, and every one of them was being thrown away.
     *
     * An ice breaker or a template button sends a `postback`, whose id lives
     * at `postback.mid` rather than `message.mid` — so it fell through the
     * "carries no message id" guard below and was skipped in silence. A
     * customer action, subscribed to deliberately, ingested, and never shown
     * to anybody.
     *
     * Mapped onto a message rather than projected by a path of its own,
     * because from the inbox's side that is exactly what it is: the customer
     * said the words on the button. Everything downstream — resolving them,
     * opening the thread, the reply window — then applies unchanged, which is
     * the whole reason not to write a second projector for it.
     */
    const message = event.message ?? postbackAsMessage(event.postback);

    if (event.message_edit?.mid) {
      return this.handleMessageEdit(enterpriseId, channelId, event, attemptCount);
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

    /*
     * A TAP IS A MESSAGE, and it was being thrown away.
     *
     * An ice breaker or a template button sends a `postback`, whose id lives at
     * `postback.mid`. The guard below reads `message.mid`, so every one of them
     * was skipped as "carries no message id" — a customer action, subscribed
     * for deliberately, ingested, and never shown to anybody.
     *
     * Projected as what it is: the customer said the words on the button. The
     * PAYLOAD behind it is ours rather than theirs, so it goes in the metadata
     * where an automation can read it without an agent seeing an opaque token
     * in the thread.
     */
    /*
     * An opt-in is consent, not conversation. Named in the skip so it is
     * visible as a decision rather than lost among malformed events — we
     * subscribe to these, and "no message id" said nothing about why one was
     * here.
     */
    if (!message?.mid && event.optin) {
      return { projected: false, reason: 'a messaging opt-in, which is consent rather than a message' };
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
    /*
     * What the tapped button MEANT, as distinct from what it said. An
     * automation routes on this; an agent should never have to read it.
     */
    if (event.postback?.payload) platformFacts.postbackPayload = event.postback.payload;
    if (event.postback?.mid) platformFacts.isPostback = true;
    if (message.is_unsupported === true) platformFacts.isUnsupported = true;
    if (event.referral) platformFacts.referral = event.referral;

    /*
     * A RECOVERED MESSAGE WITH NOTHING IN IT.
     *
     * Meta exposes a shared post, story or reel only on the live webhook. Every
     * read path returns it empty — the conversations edge, and the message node
     * asked directly for attachments, shares, story and sticker. So when a
     * delivery is dropped and the resync recovers the message, we get its id and
     * its timestamp and no content, ever.
     *
     * Marked rather than left blank: the thread was showing "(no text)", which
     * reads as a customer sending an empty message. What actually happened is
     * that they sent something and the platform will not tell us what.
     */
    if (event.recovered === true && !message?.text && media.attachments.length === 0) {
      platformFacts.contentUnavailable = true;
    }

    /*
     * AN ATTACHMENT THAT IS AN EMPTY BOX.
     *
     * The case above is a message with no attachments at all. This is the other
     * shape, and it arrives on the LIVE webhook: Meta sends an attachment whose
     * payload carries nothing usable — no url, no title, no sticker.
     *
     * Observed 26 Sep sharing a COMMENT on an advert into a DM. It arrived as
     * `{"type":"template","payload":{"generic":{"elements":[]}}}` — an empty
     * elements array — and was stored as a `document` attachment with no link,
     * which the thread rendered as "(document, no link)". An agent reading that
     * learns nothing; the customer did send something.
     *
     * Deliberately NOT keyed on `template`: what makes this unreadable is that
     * the payload is empty, and Meta has renamed these types before (`share`
     * became `ig_reel` mid-September). An empty box is an empty box whatever it
     * is labelled.
     */
    if (
      !message?.text &&
      media.attachments.length > 0 &&
      media.attachments.every(
        (attachment) =>
          !attachment.sourceUrl &&
          attachment.metadata.title === undefined &&
          attachment.metadata.stickerId === undefined,
      )
    ) {
      platformFacts.contentUnavailable = true;
    }

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
        conversationKind: ConversationKind.DirectMessage,
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

    /*
     * NOT US. On an echo the recipient is the customer, and an event naming the
     * business on both sides describes no conversation at all — it opened a
     * thread keyed on our own account id with a nameless customer that was us.
     * Refused rather than stored, because there is no thread this belongs to.
     */
    if (customerScopedId === event.sender?.id) {
      return { projected: false, reason: 'our own message names us as its recipient' };
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
    attemptCount: number,
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

    /*
     * AN ORPHAN EDIT IS NOT YET PROOF OF A LOST DELIVERY.
     *
     * Meta can send the edit BEFORE the message it edits — observed 0.7 seconds
     * apart on live traffic — so acting on first sight fired a resync that
     * recovered nothing and spent a Graph call to learn what arrived a moment
     * later anyway.
     *
     * Thrown rather than skipped, so the ledger's own retry does the waiting:
     * skipping is TERMINAL, and the message landing a second later would never
     * be reconsidered. On the next pass the guard above finds it and this ends
     * as "already hold" with no platform call at all.
     *
     * This is a deliberate wait, not a failure — the message says so, because
     * it is what an operator reading `last_error` will see.
     */
    if (attemptCount <= ORPHAN_EDIT_GRACE_ATTEMPTS) {
      throw new Error(
        'a message_edit arrived before the message it names; waiting one pass before assuming the delivery was lost',
      );
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
