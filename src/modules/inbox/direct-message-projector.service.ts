import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
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
import type { ProjectionOutcome } from './comment-projector.service';
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
  };
  readonly recipient?: { readonly id?: string };
  readonly timestamp?: number;
  readonly message?: {
    readonly mid?: string;
    readonly text?: string;
    readonly is_echo?: boolean;
    readonly attachments?: readonly { readonly type?: string }[];
  };
}

@Injectable()
export class DirectMessageProjectorService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
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

    if (!message?.mid) return { projected: false, reason: 'the event carries no message id' };
    // Same reason as above: capture what the guard proved, for use in the closure.
    const platformMessageId = message.mid;

    /*
     * is_echo marks a message the PAGE sent — Meta echoes our own sends back.
     * Projecting it would duplicate the outbound row the reply flow already
     * created, and would attribute our own words to the customer.
     */
    if (message.is_echo === true) {
      return { projected: false, reason: 'an echo of our own outbound message' };
    }

    const senderId = event.sender?.id;
    if (!senderId) return { projected: false, reason: 'the message names no sender' };

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

      const inserted = await this.messages.insertInbound({
        enterpriseId,
        conversationId: conversation.id,
        customerId: customer.customerId,
        inboundEventId,
        platformMessageId,
        messageKind: message.attachments?.length ? MessageKind.Image : MessageKind.Text,
        body: message.text ?? null,
        platformSentAt: event.timestamp ? new Date(event.timestamp) : null,
        parentMessageId: null,
      });

      if (!inserted) return { projected: false, reason: 'the message was already projected' };

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
}
