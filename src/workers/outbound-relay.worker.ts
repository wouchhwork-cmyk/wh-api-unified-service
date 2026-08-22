import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import {
  OutboundEventRepository,
  type ClaimedOutboundEvent,
} from '@/database/repositories/outbound-event.repository';
import { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import { GraphApiError } from '@/modules/connections/graph/graph-api.error';
import { isAmbiguousFailure, mapGraphError } from '@/modules/connections/graph/graph-error.mapper';
import { scheduleRetry } from '@/modules/ledger/backoff.util';
import { TokenCipherService } from '@/shared/crypto';
import { ConnectionStatus, MessageStatus, OutboundEventType, Platform } from '@/shared/enums';
import { BasePoller } from './base-poller';

interface CommentReplyPayload {
  readonly commentId?: string;
  readonly message?: string;
}
interface DirectMessagePayload {
  readonly message?: string;
}
interface CommentModerationPayload {
  readonly commentId?: string;
  readonly hidden?: boolean;
}

/**
 * Sends what the domain queued, and writes the outcome back.
 *
 * This is the only place a platform call is made on behalf of a domain action,
 * which is what keeps the send rules in one place rather than at every call site.
 */
@Injectable()
export class OutboundRelayWorker extends BasePoller {
  protected readonly name = 'outbound-relay';

  constructor(
    private readonly outbound: OutboundEventRepository,
    private readonly channels: ChannelRepository,
    private readonly connections: ProviderConnectionRepository,
    private readonly messages: MessageRepository,
    private readonly graph: GraphApiClient,
    private readonly cipher: TokenCipherService,
    protected readonly config: AppConfigService,
    @InjectPinoLogger(OutboundRelayWorker.name) protected readonly logger: PinoLogger,
  ) {
    super();
  }

  protected async pollOnce(): Promise<number> {
    const { batchSize, leaseSeconds } = this.config.worker;
    const claimed = await this.outbound.claimDueBatch(this.leaseOwner, batchSize, leaseSeconds);

    for (const event of claimed) {
      await this.deliver(event);
    }
    return claimed.length;
  }

  private async deliver(event: ClaimedOutboundEvent): Promise<void> {
    if (event.enterpriseId === null || event.channelId === null) {
      await this.settleAsFailed(event.id, 'the event names no channel to send through');
      return;
    }

    const channel = await this.channels.findSendContext(event.enterpriseId, event.channelId);
    if (!channel) {
      await this.settleAsFailed(event.id, 'the channel no longer exists');
      return;
    }

    /*
     * FAIL FAST ON A DEAD TOKEN. Checked before sending rather than after
     * failing: burning five attempts against a credential that cannot succeed
     * delays every other item in the queue and tells the operator nothing new.
     */
    if (channel.reauthRequired) {
      await this.settleAsFailed(event.id, 'the channel needs re-authentication');
      return;
    }
    if (!channel.isManaged) {
      await this.settleAsFailed(event.id, 'the channel is not managed');
      return;
    }
    if (!channel.effectiveAccessToken) {
      await this.settleAsFailed(event.id, 'no usable access token for the channel');
      return;
    }

    let token: string;
    try {
      token = this.cipher.decrypt(channel.effectiveAccessToken);
    } catch (error) {
      // A decryption failure is an ALERT, not a fallback: it means key loss or
      // tampering. Treating it as "no token" would show a user a mysterious
      // re-auth prompt and hide a serious problem.
      this.logger.error(
        { channelId: channel.channelId, err: error },
        'could not decrypt a channel token — key loss or tampering',
      );
      await this.settleAsFailed(event.id, 'the channel token could not be decrypted');
      return;
    }

    /*
     * Re-check the lease immediately before the send. A batch of 20 sends, each
     * allowed 10 s, can run for 200 s against a stalling platform — longer than
     * the 120 s lease — after which the reaper re-queues the row and another
     * worker may already be sending it. Checking here shrinks that window to one
     * call, and the fenced write-back below closes it.
     */
    if (!(await this.outbound.stillHoldsLease(event.id, this.leaseOwner))) {
      this.logger.warn(
        { eventId: event.id },
        'lease lapsed before sending — another worker owns this row now',
      );
      return;
    }

    try {
      /*
       * INSTAGRAM SENDS GO TO THE PAGE. Addressing the Instagram account returns
       * Meta error 3 — "Application does not have the capability" — which reads
       * as a missing app permission and is not: the Instagram messaging surface
       * lives on the linked Page. Verified against a live account: the Instagram
       * id returns 3, the Page id reaches the real answer (the 24-hour window).
       *
       * Comments are NOT affected: a comment is addressed by its own id.
       */
      const messagingTarget =
        channel.platform === Platform.Instagram
          ? (channel.parentPlatformChannelId ?? channel.platformChannelId)
          : channel.platformChannelId;

      const platformId = await this.send(event, channel.platformChannelId, token, messagingTarget);
      const settled = await this.outbound.markSent(event.id, this.leaseOwner, platformId);

      if (!settled) {
        // The send happened but the lease was gone, so another worker may send
        // it again. Loud, because it is the one case that can duplicate a
        // customer-visible message.
        this.logger.error(
          { eventId: event.id },
          'sent AFTER the lease lapsed — a duplicate send is possible',
        );
        return;
      }

      /*
       * The delivery write-back, keyed on the LEDGER row rather than the message:
       * the relay knows which event it sent, not which message — which is why
       * messages_outbound_event_idx exists. Without this the message would stay
       * 'pending' forever even though the reply was delivered.
       */
      await this.messages.recordDelivery(event.id, platformId, MessageStatus.Sent);
    } catch (error) {
      await this.handleSendFailure(event, error);
    }
  }

  /**
   * Cancels the ledger row AND settles the message.
   *
   * Kept as one call because the two must not diverge: a cancelled event with a
   * message still showing 'pending' means the agent watches a reply that will
   * never be delivered and never be marked failed.
   */
  private async settleAsFailed(eventId: number, reason: string): Promise<void> {
    await this.outbound.cancel(eventId, reason);
    await this.messages.recordDelivery(eventId, null, MessageStatus.Failed);
  }

  private async send(
    event: ClaimedOutboundEvent,
    platformChannelId: string,
    token: string,
    messagingTarget: string,
  ): Promise<string | null> {
    switch (event.eventType) {
      case OutboundEventType.CommentReply: {
        const payload = event.payload as CommentReplyPayload;
        if (!payload.commentId || !payload.message) throw new Error('incomplete comment reply');
        const result = await this.graph.replyToComment(payload.commentId, payload.message, token);
        return result.platformId;
      }
      case OutboundEventType.DirectMessage: {
        const payload = event.payload as DirectMessagePayload;
        if (!event.recipientPlatformId || !payload.message) {
          throw new Error('incomplete direct message');
        }
        const result = await this.graph.sendDirectMessage(
          messagingTarget,
          event.recipientPlatformId,
          payload.message,
          token,
        );
        return result.platformId;
      }
      case OutboundEventType.CommentHide: {
        const payload = event.payload as CommentModerationPayload;
        if (!payload.commentId) throw new Error('incomplete comment hide');
        await this.graph.hideComment(payload.commentId, payload.hidden ?? true, token);
        return null;
      }
      case OutboundEventType.CommentDelete: {
        const payload = event.payload as CommentModerationPayload;
        if (!payload.commentId) throw new Error('incomplete comment delete');
        await this.graph.deleteComment(payload.commentId, token);
        return null;
      }
      default:
        // A type with no sender is a wiring gap, not a transient failure.
        throw new Error(`no sender for event_type "${event.eventType}"`);
    }
  }

  private async handleSendFailure(event: ClaimedOutboundEvent, error: unknown): Promise<void> {
    if (!(error instanceof GraphApiError)) {
      const retry = scheduleRetry(event.attemptCount, event.maxAttempts);
      await this.outbound.markFailed(
        event.id,
        error instanceof Error ? error.message : 'send failed',
        retry?.nextAttemptAt ?? null,
      );
      if (!retry) await this.messages.recordDelivery(event.id, null, MessageStatus.Failed);
      return;
    }

    const mapped = mapGraphError(error);

    /*
     * A LIVE AUTH ERROR BEATS THE CALENDAR. Providers revoke early — a password
     * change, an app removal — so the connection is flagged the moment a call
     * says the credential is dead, rather than waiting for the expiry sweep.
     * Flagging the parent cascades to every channel under it.
     */
    if (mapped.requiresReauth && event.enterpriseId !== null && event.channelId !== null) {
      const channel = await this.channels.findSendContext(event.enterpriseId, event.channelId);
      if (channel) {
        // The CONNECTION's id, and the enterprise, so the flag lands on the
        // credential that actually died rather than on whatever row shares the
        // number.
        await this.connections.markReauthRequired(
          event.enterpriseId,
          channel.providerConnectionId,
          ConnectionStatus.Revoked,
        );
      }
      await this.settleAsFailed(event.id, 'the provider rejected the credential');
      return;
    }

    /*
     * THE AMBIGUOUS SEND (schema.md case 5) — the one duplicate no constraint
     * can prevent. We timed out or got a 5xx, so we do not know whether Meta
     * created the comment. Meta offers no idempotency token on these endpoints,
     * so blindly retrying may post twice.
     *
     * Until the read-back is implemented, the row is CANCELLED rather than
     * retried: a missing reply an agent can see and resend is recoverable, a
     * duplicate reply to a customer is not. This is a deliberate choice of the
     * cheaper failure, and it is why this branch is explicit rather than folded
     * into the generic retry.
     */
    if (isAmbiguousFailure(error)) {
      this.logger.warn(
        { eventId: event.id, httpStatus: error.httpStatus, code: error.code },
        'send failed ambiguously — not retrying, because the platform may have accepted it',
      );
      await this.settleAsFailed(
        event.id,
        'the outcome was ambiguous; a read-back is required before any retry',
      );
      return;
    }

    if (!mapped.retryable) {
      await this.outbound.markFailed(event.id, `${mapped.code}: ${error.message}`, null);
      await this.messages.recordDelivery(event.id, null, MessageStatus.Failed);
      return;
    }

    const retry = scheduleRetry(event.attemptCount, event.maxAttempts);
    await this.outbound.markFailed(
      event.id,
      `${mapped.code}: ${error.message}`,
      retry?.nextAttemptAt ?? null,
    );
    // Only a spent budget is terminal; while retries remain the message stays
    // pending, because it may still be delivered.
    if (!retry) await this.messages.recordDelivery(event.id, null, MessageStatus.Failed);
  }
}
