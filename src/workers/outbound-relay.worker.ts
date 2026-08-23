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
import { parkFor, scheduleRetry } from '@/modules/ledger/backoff.util';
import { OUTBOUND_RATE_LIMIT_MAX_WAIT_MS, OUTBOUND_RATE_LIMIT_PARK_MS } from '@/shared/constants';
import { TransactionManager } from '@/database/transaction';
import { TokenCipherService } from '@/shared/crypto';
import { ConnectionStatus, MessageStatus, OutboundEventType, Platform } from '@/shared/enums';
import { ErrorCode } from '@/shared/errors';
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
    private readonly tx: TransactionManager,
    protected readonly config: AppConfigService,
    @InjectPinoLogger(OutboundRelayWorker.name) protected readonly logger: PinoLogger,
  ) {
    super();
  }

  protected async pollOnce(): Promise<number> {
    const { batchSize, leaseSeconds } = this.config.worker;
    const claimed = await this.outbound.claimDueBatch(this.leaseOwner, batchSize, leaseSeconds);

    for (const event of claimed) {
      /*
       * PER-ROW ISOLATION. One row's unexpected failure used to abandon the rest
       * of the batch mid-flight, leaving up to nineteen claimed rows leased and
       * untouched until the reaper aged them out — so a single poison row could
       * stall the queue for a whole lease period, repeatedly.
       *
       * The settle paths already handle every failure they expect; this catches
       * the ones nobody predicted.
       */
      try {
        await this.deliver(event);
      } catch (error) {
        this.logger.error(
          { eventId: event.id, err: error },
          'delivering one event threw unexpectedly — the rest of the batch continues',
        );
      }
    }
    return claimed.length;
  }

  private async deliver(event: ClaimedOutboundEvent): Promise<void> {
    if (event.enterpriseId === null || event.channelId === null) {
      await this.settleAsFailed(
        event.enterpriseId,
        event.id,
        'the event names no channel to send through',
      );
      return;
    }

    const channel = await this.channels.findSendContext(event.enterpriseId, event.channelId);
    if (!channel) {
      await this.settleAsFailed(event.enterpriseId, event.id, 'the channel no longer exists');
      return;
    }

    /*
     * FAIL FAST ON A DEAD TOKEN. Checked before sending rather than after
     * failing: burning five attempts against a credential that cannot succeed
     * delays every other item in the queue and tells the operator nothing new.
     */
    if (channel.reauthRequired) {
      await this.settleAsFailed(
        event.enterpriseId,
        event.id,
        'the channel needs re-authentication',
      );
      return;
    }
    if (!channel.isManaged) {
      await this.settleAsFailed(event.enterpriseId, event.id, 'the channel is not managed');
      return;
    }
    if (!channel.effectiveAccessToken) {
      await this.settleAsFailed(
        event.enterpriseId,
        event.id,
        'no usable access token for the channel',
      );
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
      await this.settleAsFailed(
        event.enterpriseId,
        event.id,
        'the channel token could not be decrypted',
      );
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

    let platformId: string | null = null;
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

      platformId = await this.send(
        event,
        channel.platformChannelId,
        token,
        messagingTarget,
        channel.platform,
      );
    } catch (error) {
      await this.handleSendFailure(event, error);
      return;
    }

    /*
     * PAST THIS LINE THE SEND HAS ALREADY HAPPENED, so nothing below may be
     * reported as a send failure.
     *
     * The two settlement writes used to sit inside the try above. A database
     * error after a successful send — a pool reset, a statement_timeout — was
     * therefore handed to handleSendFailure, which called markFailed on a row
     * whose status was already 'sent'; the relay re-claimed it and delivered the
     * customer the same reply a second time, overwriting platform_event_id so
     * nothing in the data showed it had happened. markFailed now refuses to
     * touch a settled row, and this try is scoped to the send alone.
     */
    try {
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
      await this.messages.recordDelivery(
        // Non-null past the first guard in this method, which returns when the
        // event names no enterprise.
        event.enterpriseId,
        event.id,
        platformId,
        MessageStatus.Sent,
      );
    } catch (error) {
      /*
       * Loud and deliberately swallowed. The reply IS with the customer, so the
       * one thing we must not do is mark the row failed and send it again. If
       * markSent itself was what failed the row keeps its 'sending' status and
       * the reaper will re-queue it — an at-least-once send that only a
       * read-back can close (schema.md case 5) — and this line is the record
       * that it happened.
       */
      this.logger.error(
        { eventId: event.id, err: error },
        'the send succeeded but recording it did not — the ledger row may be re-queued',
      );
    }
  }

  /**
   * Cancels the ledger row AND settles the message.
   *
   * Kept as one call because the two must not diverge: a cancelled event with a
   * message still showing 'pending' means the agent watches a reply that will
   * never be delivered and never be marked failed.
   */
  private async settleAsFailed(
    enterpriseId: number | null,
    eventId: number,
    reason: string,
  ): Promise<void> {
    /*
     * ONE TRANSACTION, because this method's own contract is that the two writes
     * must not diverge — and without one they could: a cancelled ledger row
     * whose message still reads 'pending' leaves an agent watching a reply that
     * will never be delivered and never be marked failed.
     */
    await this.tx.runInTransaction(() => this.settle(enterpriseId, eventId, reason));
  }

  private async settle(
    enterpriseId: number | null,
    eventId: number,
    reason: string,
  ): Promise<void> {
    if (!(await this.outbound.cancel(eventId, this.leaseOwner, reason))) {
      // Either the row is already sent or the lease moved on. Writing the
      // message as failed anyway would tell an agent a delivered reply failed.
      this.logger.warn(
        { eventId },
        'declined to cancel — the row is already settled or owned by another worker',
      );
      return;
    }

    /*
     * NULLABLE, because one caller genuinely has no tenant: the row that names
     * no enterprise at all. The message write is tenant-scoped now, so there is
     * nothing safe to write for that row — said out loud rather than skipped
     * quietly, because a message stuck at 'pending' forever is what an agent
     * sees.
     */
    if (enterpriseId === null) {
      this.logger.error(
        { eventId, reason },
        'cancelled an event with no enterprise — any message it belongs to stays pending',
      );
      return;
    }
    await this.messages.recordDelivery(enterpriseId, eventId, null, MessageStatus.Failed);
  }

  private async send(
    event: ClaimedOutboundEvent,
    platformChannelId: string,
    token: string,
    messagingTarget: string,
    platform: Platform,
  ): Promise<string | null> {
    switch (event.eventType) {
      case OutboundEventType.CommentReply: {
        const payload = event.payload as CommentReplyPayload;
        if (!payload.commentId || !payload.message) throw new Error('incomplete comment reply');
        const result = await this.graph.replyToComment(
          payload.commentId,
          payload.message,
          token,
          // Instagram nests a reply under /replies, Facebook under /comments.
          platform,
        );
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
        // Instagram takes `hide`, Facebook takes `is_hidden`. Meta ignores the
        // wrong one silently, so passing the platform is what makes the call do
        // anything at all.
        await this.graph.hideComment(payload.commentId, payload.hidden ?? true, token, platform);
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
    /*
     * Resolved once. The message write-back is tenant-scoped, and this row's
     * enterprise is nullable — so a row with no tenant settles the LEDGER and
     * says that its message cannot be settled, rather than throwing here.
     */
    const enterpriseId = event.enterpriseId;
    const settleMessage = async (): Promise<void> => {
      if (enterpriseId === null) {
        this.logger.error(
          { eventId: event.id },
          'a failed event names no enterprise — any message it belongs to stays pending',
        );
        return;
      }
      await this.messages.recordDelivery(enterpriseId, event.id, null, MessageStatus.Failed);
    };
    if (!(error instanceof GraphApiError)) {
      const retry = scheduleRetry(event.attemptCount, event.maxAttempts);
      const applied = await this.outbound.markFailed(
        event.id,
        this.leaseOwner,
        error instanceof Error ? error.message : 'send failed',
        retry?.nextAttemptAt ?? null,
      );
      if (applied && !retry) {
        await settleMessage();
      }
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
      await this.settleAsFailed(
        event.enterpriseId,
        event.id,
        'the provider rejected the credential',
      );
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
        event.enterpriseId,
        event.id,
        'the outcome was ambiguous; a read-back is required before any retry',
      );
      return;
    }

    if (!mapped.retryable) {
      const applied = await this.outbound.markFailed(
        event.id,
        this.leaseOwner,
        `${mapped.code}: ${error.message}`,
        null,
      );
      if (applied) await settleMessage();
      return;
    }

    /*
     * A RATE LIMIT IS NOT A FAILED ATTEMPT.
     *
     * It used to be one: an ordinary retryable error on a curve that spans about
     * three seconds across the whole budget, so a brief Meta throttle burned
     * every attempt while the limit was still in force and dead-lettered a reply
     * the platform would have accepted minutes later.
     *
     * It now parks without spending an attempt, for as long as META ITSELF says
     * the quota needs — `estimated_time_to_regain_access`, when the response
     * carried it — and for a jittered five minutes when Meta said nothing.
     * Bounded by the reply's age, so a quota that never clears still becomes an
     * operator's problem rather than an immortal row.
     */
    if (mapped.code === ErrorCode.UpstreamRateLimited) {
      const advertised = error.retryAfterMinutes;
      const outcome = await this.outbound.markRateLimited({
        id: event.id,
        leaseOwner: this.leaseOwner,
        retryAt:
          advertised === null ? parkFor(OUTBOUND_RATE_LIMIT_PARK_MS) : parkFor(advertised * 60_000),
        error: `${mapped.code}: ${error.message}`,
        maxWaitMs: OUTBOUND_RATE_LIMIT_MAX_WAIT_MS,
      });

      this.logger.warn(
        { eventId: event.id, outcome, advertisedMinutes: advertised },
        outcome === 'dead_lettered'
          ? 'rate limited for longer than a reply may wait — dead-lettered'
          : 'rate limited — parked without spending an attempt',
      );

      if (outcome === 'dead_lettered') await settleMessage();
      return;
    }

    const retry = scheduleRetry(event.attemptCount, event.maxAttempts);
    const applied = await this.outbound.markFailed(
      event.id,
      this.leaseOwner,
      `${mapped.code}: ${error.message}`,
      retry?.nextAttemptAt ?? null,
    );
    // Only a spent budget is terminal; while retries remain the message stays
    // pending, because it may still be delivered.
    if (applied && !retry) {
      await settleMessage();
    }
  }
}
