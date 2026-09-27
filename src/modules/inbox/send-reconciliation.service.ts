import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import { ResolvedMentionReply } from '@/modules/connections/graph/graph.types';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import {
  AmbiguousSend,
  OutboundEventRepository,
  ReadBackOutcome,
} from '@/database/repositories/outbound-event.repository';
import { TokenCipherService } from '@/shared/crypto';
import { MessageStatus, OutboundEventType } from '@/shared/enums';
import {
  SEND_READ_BACK_DELAY_MS,
  SEND_READ_BACK_MATCH_WINDOW_MS,
  SEND_READ_BACK_WINDOW_MS,
  SEND_RECONCILE_BATCH,
} from '@/shared/constants';

export interface SendReconcileSummary {
  readonly runId: string;
  readonly considered: number;
  readonly landed: number;
  readonly lost: number;
  readonly unknown: number;
}

/** What the payload of a reply send carries, as much of it as matters here. */
interface ReplyPayload {
  readonly mediaId?: unknown;
  readonly commentId?: unknown;
  readonly message?: unknown;
}

/**
 * Resolves sends whose outcome Meta never told us.
 *
 * WHY THIS EXISTS. A reply can fail in a way that does not say whether it was
 * accepted — a timeout, a 5xx, a response lost in transit. The relay settles
 * those as cancelled rather than retrying, because Meta offers no idempotency
 * token on these endpoints and a duplicate reply to a customer is worse than a
 * missing one. That is the right call and it is only half an answer: the
 * comment may well be LIVE, and until something looks, the inbox says `failed`
 * about a reply the customer can read. An agent who believes it sends it again.
 *
 * Observed on live traffic 27 Sep 2026 (todo E20): comment 18115614217814583,
 * "Thanks for the mention!", public on Instagram, `failed` here.
 *
 * Instagram sends no echo for a comment, so nothing corrects this on its own.
 * A read-back is the only evidence available, and this is it.
 */
@Injectable()
export class SendReconciliationService {
  constructor(
    private readonly outbound: OutboundEventRepository,
    private readonly messages: MessageRepository,
    private readonly channels: ChannelRepository,
    private readonly graph: GraphApiClient,
    private readonly cipher: TokenCipherService,
    @InjectPinoLogger(SendReconciliationService.name)
    private readonly logger: PinoLogger,
  ) {}

  async reconcileAll(): Promise<SendReconcileSummary> {
    const runId = randomUUID();
    const pending = await this.outbound.listAmbiguousAwaitingReadBack({
      limit: SEND_RECONCILE_BATCH,
      settledBeforeMs: SEND_READ_BACK_DELAY_MS,
    });

    const tally: Record<ReadBackOutcome, number> = { landed: 0, lost: 0, unknown: 0 };
    for (const send of pending) {
      try {
        tally[await this.reconcileOne(send, runId)] += 1;
      } catch (error) {
        /*
         * One send's failure must not end the run. The row keeps no `readBack`
         * marker, so the next sweep picks it up again — which is the behaviour
         * we want for a transient Graph failure, and harmless for a permanent
         * one because the window eventually ages it out to `unknown`.
         */
        this.logger.error(
          { runId, eventId: send.id, err: error },
          'could not read back an ambiguous send',
        );
      }
    }

    if (pending.length > 0) {
      this.logger.info({ runId, considered: pending.length, ...tally }, 'read back ambiguous sends');
    }
    return { runId, considered: pending.length, ...tally };
  }

  private async reconcileOne(send: AmbiguousSend, runId: string): Promise<ReadBackOutcome> {
    /*
     * AGED OUT. Instagram's comments edge returns a recent window, so past it
     * "not found" is not evidence of anything. Settled as UNKNOWN without
     * spending a call — and deliberately not as `lost`, because a lost send
     * invites a resend and this one was never disproven.
     */
    if (Date.now() - send.lastErrorAt.getTime() > SEND_READ_BACK_WINDOW_MS) {
      await this.resolve(send, 'unknown', null);
      return 'unknown';
    }

    const channel = await this.channels.findSendContext(send.enterpriseId, send.channelId);
    if (!channel?.effectiveAccessToken || !channel.isManaged || channel.reauthRequired) {
      /*
       * No usable credential. Not `lost` either: we cannot see, which is a
       * different fact from having looked and found nothing.
       */
      await this.resolve(send, 'unknown', null);
      return 'unknown';
    }

    /*
     * THE STORED TOKEN IS ENCRYPTED. Passing it to Graph unopened fails as an
     * auth error, which would read as "the reply is not there" and mark a live
     * comment lost — the single worst answer this service can give.
     */
    let token: string;
    try {
      token = this.cipher.decrypt(channel.effectiveAccessToken);
    } catch (error) {
      this.logger.error(
        { runId, eventId: send.id, err: error },
        'could not decrypt a channel token — key loss or tampering',
      );
      await this.resolve(send, 'unknown', null);
      return 'unknown';
    }

    const payload = send.payload as ReplyPayload;
    const sentText = typeof payload.message === 'string' ? payload.message : null;
    if (sentText === null) {
      // Nothing to match on. A media-only reply cannot be identified by text.
      await this.resolve(send, 'unknown', null);
      return 'unknown';
    }

    const candidates = await this.readBack(send, payload, channel.platformChannelId, token);
    const match = this.findMatch(candidates, sentText, send.lastErrorAt);

    if (match) {
      await this.resolve(send, 'landed', match.platformId);
      this.logger.warn(
        { runId, eventId: send.id, platformId: match.platformId },
        'an ambiguous send HAD landed — the inbox said failed and the reply was live',
      );
      return 'landed';
    }

    await this.resolve(send, 'lost', null);
    return 'lost';
  }

  /** The right edge for the kind of reply this was. */
  private async readBack(
    send: AmbiguousSend,
    payload: ReplyPayload,
    instagramUserId: string,
    token: string,
  ): Promise<ResolvedMentionReply[]> {
    const mediaId = typeof payload.mediaId === 'string' ? payload.mediaId : null;
    const commentId = typeof payload.commentId === 'string' ? payload.commentId : null;

    if (send.eventType === OutboundEventType.CommentReply) {
      // Our own media: the reply sits under the comment it answered.
      const parent = commentId ?? send.destinationId;
      return parent ? this.graph.listCommentReplies(parent, token) : [];
    }

    /*
     * A MENTION. Which edge depends on how we were mentioned, and the two are
     * not interchangeable: a COMMENT mention puts our reply in the thread under
     * that comment, a CAPTION mention has no comment at all and our reply is a
     * top-level comment on the post.
     */
    if (commentId) return this.graph.listMentionedPostComments(instagramUserId, commentId, token);
    return mediaId ? this.graph.listMentionedMediaComments(instagramUserId, mediaId, token) : [];
  }

  /**
   * TEXT AND TIME, never text alone.
   *
   * An agent who sends "Thanks!" twice in a day would otherwise have the second
   * send matched against the first one's comment — and the second reply would
   * be marked delivered while it is genuinely missing.
   */
  private findMatch(
    candidates: readonly ResolvedMentionReply[],
    sentText: string,
    attemptedAt: Date,
  ): ResolvedMentionReply | null {
    const wanted = sentText.trim();
    for (const candidate of candidates) {
      if ((candidate.text ?? '').trim() !== wanted) continue;
      if (candidate.timestamp === null) continue;
      const posted = Date.parse(candidate.timestamp);
      if (Number.isNaN(posted)) continue;
      if (Math.abs(posted - attemptedAt.getTime()) <= SEND_READ_BACK_MATCH_WINDOW_MS) return candidate;
    }
    return null;
  }

  /**
   * Records the verdict on the ledger row and, when it landed, corrects the
   * message the agent is looking at.
   *
   * THE LEDGER FIRST. `markReadBackResolved` will not apply twice, so if the
   * message write fails the next sweep does not re-promote a row — it skips it,
   * and the disagreement is visible in the ledger rather than being papered
   * over by a second promotion that might land differently.
   */
  private async resolve(
    send: AmbiguousSend,
    outcome: ReadBackOutcome,
    platformEventId: string | null,
  ): Promise<void> {
    const applied = await this.outbound.markReadBackResolved({
      id: send.id,
      outcome,
      platformEventId,
    });
    if (!applied) return;

    if (outcome === 'landed') {
      await this.messages.recordDelivery(
        send.enterpriseId,
        send.id,
        platformEventId,
        MessageStatus.Sent,
      );
    }
  }
}
