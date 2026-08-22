import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';

export interface QueueGauge {
  readonly queue: 'inbound' | 'outbound' | 'sync';
  /** Claimable rows, whether or not they are due yet. */
  readonly depth: number;
  /** Claimable AND due now — work a worker could take this instant. */
  readonly due: number;
  /**
   * Age of the OLDEST due row. This is the number to alert on: depth says how
   * much is waiting, this says how far behind the workers actually are, and only
   * the second one distinguishes a busy queue from a stalled one.
   */
  readonly oldestDueAgeSeconds: number | null;
  /** Rows a worker currently holds. A number that never falls means stuck leases. */
  readonly leased: number;
  /** Terminal failures. Any non-zero value here is a human's problem. */
  readonly deadLettered: number;
}

/**
 * Operational gauges for the three queues.
 *
 * DELIBERATELY NOT TENANT-SCOPED, and safe to be: every column returned is a
 * count or an age. No payload, no identifier, no tenant is exposed, so there is
 * nothing here to leak across a boundary — and a per-tenant queue depth would
 * answer the wrong question anyway, because the workers are shared.
 *
 * One round trip for all three queues: this is sampled on a timer and read by a
 * health endpoint, and three separate probes would be three times the load for
 * the same answer.
 */
@Injectable()
export class QueueMetricsRepository extends BaseRepository {
  async gauges(): Promise<QueueGauge[]> {
    return this.query<QueueGauge>(
      `WITH inbound AS (
         SELECT 'inbound' AS queue,
                count(*) FILTER (WHERE status IN ('pending','failed'))            AS depth,
                count(*) FILTER (WHERE status IN ('pending','failed')
                                   AND COALESCE(next_attempt_at, created_at) <= now()) AS due,
                min(created_at) FILTER (WHERE status IN ('pending','failed')
                                   AND COALESCE(next_attempt_at, created_at) <= now()) AS oldest_due,
                count(*) FILTER (WHERE status IN ('leased','processing'))          AS leased,
                count(*) FILTER (WHERE status = 'dead_letter')                     AS dead_lettered
           FROM inbound_events
       ),
       outbound AS (
         SELECT 'outbound' AS queue,
                count(*) FILTER (WHERE status IN ('pending','scheduled','failed')) AS depth,
                count(*) FILTER (WHERE status IN ('pending','scheduled','failed')
                                   AND COALESCE(next_attempt_at, scheduled_at, created_at) <= now()) AS due,
                min(created_at) FILTER (WHERE status IN ('pending','scheduled','failed')
                                   AND COALESCE(next_attempt_at, scheduled_at, created_at) <= now()) AS oldest_due,
                count(*) FILTER (WHERE status IN ('leased','sending'))             AS leased,
                count(*) FILTER (WHERE status = 'dead_letter')                     AS dead_lettered
           FROM outbound_events
       ),
       sync AS (
         SELECT 'sync' AS queue,
                count(*) FILTER (WHERE is_deleted = false
                                   AND status IN ('pending','failed','rate_limited'))  AS depth,
                count(*) FILTER (WHERE is_deleted = false
                                   AND status IN ('pending','failed','rate_limited')
                                   AND COALESCE(next_attempt_at, rate_limited_until, created_at) <= now()) AS due,
                min(created_at) FILTER (WHERE is_deleted = false
                                   AND status IN ('pending','failed','rate_limited')
                                   AND COALESCE(next_attempt_at, rate_limited_until, created_at) <= now()) AS oldest_due,
                count(*) FILTER (WHERE is_deleted = false AND status = 'running')  AS leased,
                count(*) FILTER (WHERE is_deleted = false AND status = 'dead_letter') AS dead_lettered
           FROM sync_jobs
       ),
       combined AS (
         SELECT * FROM inbound UNION ALL SELECT * FROM outbound UNION ALL SELECT * FROM sync
       )
       SELECT queue,
              depth::int                                              AS "depth",
              due::int                                                AS "due",
              CASE WHEN oldest_due IS NULL THEN NULL
                   ELSE floor(EXTRACT(EPOCH FROM (now() - oldest_due)))::int
              END                                                     AS "oldestDueAgeSeconds",
              leased::int                                             AS "leased",
              dead_lettered::int                                      AS "deadLettered"
         FROM combined
        ORDER BY queue`,
    );
  }
}
