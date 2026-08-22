import { Injectable } from '@nestjs/common';
import {
  EventPriority,
  InboundEventStatus,
  InboundEventType,
  Platform,
  SourceKind,
} from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface InboundEventInput {
  readonly enterpriseId: number | null;
  readonly channelId: number | null;
  readonly sourceKind: SourceKind;
  readonly sourceId: string | null;
  readonly platform: Platform;
  readonly eventType: InboundEventType;
  readonly platformEventId: string | null;
  readonly dedupKey: string;
  readonly correlationId: string | null;
  readonly payload: unknown;
  readonly receivedAt: Date | null;
  readonly priority?: EventPriority;
}

@Injectable()
export class InboundEventRepository extends BaseRepository {
  /**
   * THE idempotency guard.
   *
   * A duplicate is a SUCCESS, not an error (schema.md): returning an error to
   * Meta on a redelivery guarantees more retries of something we already hold,
   * which is how a redelivery storm starts. The conflict target mirrors the
   * COALESCE expression in inbound_events_dedup_uniq exactly — a plain
   * (enterprise_id, dedup_key) target would not match the index.
   */
  async insertIgnoringDuplicate(
    input: InboundEventInput,
  ): Promise<{ id: number | null; duplicate: boolean }> {
    const { rows } = await this.mutate<{ id: number }>(
      `INSERT INTO inbound_events
         (enterprise_id, channel_id, source_kind, source_id, platform, event_type,
          platform_event_id, dedup_key, correlation_id, payload, priority, status,
          next_attempt_at, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13)
       ON CONFLICT (COALESCE(enterprise_id, 0), dedup_key) DO NOTHING
       RETURNING id`,
      [
        input.enterpriseId,
        input.channelId,
        input.sourceKind,
        input.sourceId,
        input.platform,
        input.eventType,
        input.platformEventId,
        input.dedupKey,
        input.correlationId,
        JSON.stringify(input.payload ?? {}),
        input.priority ?? EventPriority.Normal,
        InboundEventStatus.Pending,
        input.receivedAt,
      ],
    );

    const row = rows[0];
    return { id: row?.id ?? null, duplicate: row === undefined };
  }

  /**
   * Claims a batch of work in ONE statement.
   *
   * FOR UPDATE SKIP LOCKED is the whole concurrency story: two workers polling
   * concurrently can never take the same row, and neither waits for the other.
   * The ORDER BY and WHERE mirror inbound_events_claimable_idx so the scan uses
   * it — priority is numeric precisely because this ordering depends on it.
   */
  async claimBatch(
    leaseOwner: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<{ id: number; eventType: InboundEventType; payload: unknown; attemptCount: number }[]> {
    const { rows } = await this.mutate<{
      id: number;
      event_type: InboundEventType;
      payload: unknown;
      attempt_count: number;
    }>(
      `UPDATE inbound_events
          SET status = $1,
              lease_owner = $2,
              lease_expires_at = now() + ($3::int * interval '1 second'),
              attempt_count = attempt_count + 1,
              processing_started_at = COALESCE(processing_started_at, now())
        WHERE id IN (
          SELECT id FROM inbound_events
           WHERE status IN ('pending','failed')
             AND COALESCE(next_attempt_at, created_at) <= now()
           ORDER BY priority, COALESCE(next_attempt_at, created_at), id
           LIMIT $4
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, event_type, payload, attempt_count`,
      [InboundEventStatus.Processing, leaseOwner, leaseSeconds, limit],
    );

    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      payload: row.payload,
      attemptCount: row.attempt_count,
    }));
  }

  async markProcessed(id: number): Promise<void> {
    await this.mutate(
      `UPDATE inbound_events
          SET status = $2, processed_at = now(), lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1`,
      [id, InboundEventStatus.Processed],
    );
  }

  async markSkipped(id: number, reason: string): Promise<void> {
    await this.mutate(
      `UPDATE inbound_events
          SET status = $2, processed_at = now(), last_error = $3,
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1`,
      [id, InboundEventStatus.Skipped, reason],
    );
  }

  /**
   * Records a failure and schedules the retry — or dead-letters when the budget
   * is spent, so a poison row stops being retried forever and becomes visible to
   * an operator instead.
   */
  async markFailed(id: number, error: string, nextAttemptAt: Date): Promise<void> {
    await this.mutate(
      `UPDATE inbound_events
          SET status = CASE WHEN attempt_count >= max_attempts THEN $2 ELSE $3 END,
              dead_lettered_at = CASE WHEN attempt_count >= max_attempts THEN now() END,
              last_error = $4,
              last_error_at = now(),
              next_attempt_at = $5,
              lease_owner = NULL,
              lease_expires_at = NULL
        WHERE id = $1`,
      [
        id,
        InboundEventStatus.DeadLetter,
        InboundEventStatus.Failed,
        error.slice(0, 2000),
        nextAttemptAt,
      ],
    );
  }

  /** A worker that died mid-batch loses its lease, not the work. */
  async reclaimExpiredLeases(limit: number): Promise<number> {
    const { affected } = await this.mutate(
      `UPDATE inbound_events
          SET status = $1, lease_owner = NULL, lease_expires_at = NULL
        WHERE id IN (
          SELECT id FROM inbound_events
           WHERE status IN ('leased','processing') AND lease_expires_at < now()
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      [InboundEventStatus.Pending, limit],
    );
    return affected;
  }
}
