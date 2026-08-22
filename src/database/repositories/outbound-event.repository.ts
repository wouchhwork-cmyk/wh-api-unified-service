import { Injectable } from '@nestjs/common';
import {
  DestinationKind,
  EventPriority,
  OutboundEventStatus,
  OutboundEventType,
  Platform,
} from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface EnqueueOutboundInput {
  readonly enterpriseId: number | null;
  readonly channelId: number | null;
  readonly destinationKind: DestinationKind;
  readonly destinationId: string | null;
  readonly platform: Platform;
  readonly eventType: OutboundEventType;
  readonly inReplyToEventId: number | null;
  readonly recipientPlatformId: string | null;
  readonly dedupKey: string;
  readonly correlationId: string | null;
  readonly payload: unknown;
  readonly scheduledAt: Date | null;
  readonly priority?: EventPriority;
}

export interface ClaimedOutboundEvent {
  readonly id: number;
  readonly enterpriseId: number | null;
  readonly channelId: number | null;
  readonly eventType: OutboundEventType;
  readonly recipientPlatformId: string | null;
  readonly payload: unknown;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

@Injectable()
export class OutboundEventRepository extends BaseRepository {
  /**
   * Inserts the row that ANNOUNCES a state change.
   *
   * Called inside the caller's transaction, deliberately: the transactional
   * outbox rule is that this row and the state change it describes commit
   * together. Writing the domain row and then publishing outside the transaction
   * loses the event whenever the process dies in between.
   *
   * It therefore does NOT open a transaction of its own.
   */
  async enqueue(input: EnqueueOutboundInput): Promise<{ id: number | null; duplicate: boolean }> {
    const { rows } = await this.mutate<{ id: number }>(
      `INSERT INTO outbound_events
         (enterprise_id, channel_id, destination_kind, destination_id, platform, event_type,
          in_reply_to_event_id, recipient_platform_id, dedup_key, correlation_id, payload,
          priority, status, scheduled_at, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               COALESCE($14, now()))
       ON CONFLICT (COALESCE(enterprise_id, 0), dedup_key) DO NOTHING
       RETURNING id`,
      [
        input.enterpriseId,
        input.channelId,
        input.destinationKind,
        input.destinationId,
        input.platform,
        input.eventType,
        input.inReplyToEventId,
        input.recipientPlatformId,
        input.dedupKey,
        input.correlationId,
        JSON.stringify(input.payload ?? {}),
        input.priority ?? EventPriority.Normal,
        input.scheduledAt ? OutboundEventStatus.Scheduled : OutboundEventStatus.Pending,
        input.scheduledAt,
      ],
    );
    const row = rows[0];
    return { id: row?.id ?? null, duplicate: row === undefined };
  }

  /**
   * Claims due work. The ORDER BY mirrors outbound_events_due_idx exactly,
   * including its COALESCE, so a scheduled send whose time has come sorts
   * alongside a plain pending one instead of being invisible.
   */
  async claimDueBatch(
    leaseOwner: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<ClaimedOutboundEvent[]> {
    const { rows } = await this.mutate<{
      id: number;
      enterprise_id: number | null;
      channel_id: number | null;
      event_type: OutboundEventType;
      recipient_platform_id: string | null;
      payload: unknown;
      attempt_count: number;
      max_attempts: number;
      priority: number;
    }>(
      `UPDATE outbound_events
          SET status = $1,
              lease_owner = $2,
              lease_expires_at = now() + ($3::int * interval '1 second'),
              attempt_count = attempt_count + 1
        WHERE id IN (
          SELECT id FROM outbound_events
           WHERE status IN ('pending','scheduled','failed')
             AND COALESCE(next_attempt_at, scheduled_at, created_at) <= now()
           ORDER BY priority, COALESCE(next_attempt_at, scheduled_at, created_at), id
           LIMIT $4
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, enterprise_id, channel_id, event_type, recipient_platform_id,
                  payload, attempt_count, max_attempts, priority`,
      [OutboundEventStatus.Sending, leaseOwner, leaseSeconds, limit],
    );

    // Same reason as the inbound claim: RETURNING has no defined order, so
    // priority is re-applied here to order the work within the batch.
    return rows
      .sort((a, b) => a.priority - b.priority || a.id - b.id)
      .map((row) => ({
      id: row.id,
      enterpriseId: row.enterprise_id,
      channelId: row.channel_id,
      eventType: row.event_type,
      recipientPlatformId: row.recipient_platform_id,
      payload: row.payload,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
    }));
  }

  /**
   * Settles a sent row, but ONLY while we still hold the lease.
   *
   * Returns false when the lease was lost — the batch outlived it and the reaper
   * re-queued the row, so another worker now owns it. Without this fence both
   * workers would write back and the send could be duplicated with neither
   * noticing.
   */
  async markSent(
    id: number,
    leaseOwner: string,
    platformEventId: string | null,
  ): Promise<boolean> {
    const { affected } = await this.mutate(
      `UPDATE outbound_events
          SET status = $2, sent_at = now(), platform_event_id = $3,
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND lease_owner = $4
        RETURNING id`,
      [id, OutboundEventStatus.Sent, platformEventId, leaseOwner],
    );
    return affected === 1;
  }

  /** True while this worker still owns the row; false once the lease lapsed. */
  async stillHoldsLease(id: number, leaseOwner: string): Promise<boolean> {
    const rows = await this.query<{ id: number }>(
      `SELECT id FROM outbound_events
        WHERE id = $1 AND lease_owner = $2 AND lease_expires_at > now()
        LIMIT 1`,
      [id, leaseOwner],
    );
    return rows.length === 1;
  }

  async markFailed(id: number, error: string, nextAttemptAt: Date | null): Promise<void> {
    await this.mutate(
      `UPDATE outbound_events
          SET status = CASE
                WHEN $5::timestamptz IS NULL OR attempt_count >= max_attempts THEN $2
                ELSE $3 END,
              dead_lettered_at = CASE
                WHEN $5::timestamptz IS NULL OR attempt_count >= max_attempts THEN now() END,
              last_error = $4,
              last_error_at = now(),
              next_attempt_at = $5,
              lease_owner = NULL,
              lease_expires_at = NULL
        WHERE id = $1`,
      [
        id,
        OutboundEventStatus.DeadLetter,
        OutboundEventStatus.Failed,
        error.slice(0, 2000),
        nextAttemptAt,
      ],
    );
  }

  /**
   * Terminal, and deliberately distinct from a failure: used when the send can
   * never succeed as written — a dead credential, or an ambiguous outcome we
   * refuse to retry because it might send twice.
   */
  async cancel(id: number, reason: string): Promise<void> {
    await this.mutate(
      `UPDATE outbound_events
          SET status = $2, last_error = $3, last_error_at = now(),
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1`,
      [id, OutboundEventStatus.Cancelled, reason.slice(0, 2000)],
    );
  }

  async reclaimExpiredLeases(limit: number): Promise<number> {
    const { affected } = await this.mutate(
      `UPDATE outbound_events
          SET status = $1, lease_owner = NULL, lease_expires_at = NULL
        WHERE id IN (
          SELECT id FROM outbound_events
           WHERE status IN ('leased','sending') AND lease_expires_at < now()
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      [OutboundEventStatus.Pending, limit],
    );
    return affected;
  }
}
