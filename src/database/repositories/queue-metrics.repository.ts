import { Injectable } from '@nestjs/common';
import { DEAD_LETTER_ALERT_WINDOW_MS } from '@/shared/constants';
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
  /**
   * Dead letters within DEAD_LETTER_ALERT_WINDOW_MS.
   *
   * The alarm reads THIS, not the cumulative count. One poison message from
   * last month used to pin the gauge at WARN permanently, and an alarm that is
   * always on is one nobody reads.
   */
  readonly recentDeadLettered: number;
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
  /**
   * ONE SUBQUERY PER GAUGE, rather than one pass per table with FILTER.
   *
   * The FILTER form reads beautifully and scans the whole ledger: with no WHERE
   * clause, `count(*) FILTER (...) FROM inbound_events` visits every row ever
   * written, including the overwhelming majority in a terminal state. Sampled
   * every minute, that is three full scans a minute over the three
   * highest-volume tables in the schema, growing forever.
   *
   * Each subquery below repeats the predicate of an index that already exists —
   * `inbound_events_claimable_idx`, `..._expired_lease_idx`,
   * `..._dead_letter_idx` and their outbound and sync counterparts — because a
   * partial index only serves a query that names its predicate. So the work
   * becomes proportional to the ACTIVE set rather than the archive, and no new
   * index is needed to get it.
   *
   * Still one round trip, for the reason the class comment gives.
   */
  async gauges(): Promise<QueueGauge[]> {
    /*
     * The status sets, written once. They are not arbitrary: each matches a
     * partial index, so changing one here without changing that index silently
     * returns this query to a sequential scan.
     */
    const inboundClaimable = `status IN ('pending','failed')`;
    const outboundClaimable = `status IN ('pending','scheduled','failed')`;
    const syncClaimable = `is_deleted = false AND status IN ('pending','failed','rate_limited')`;

    const queue = (
      name: string,
      table: string,
      claimable: string,
      dueAt: string,
      leased: string,
      deadLetter: string,
    ): string => `
      SELECT '${name}' AS queue,
             (SELECT count(*) FROM ${table} WHERE ${claimable}) AS depth,
             (SELECT count(*) FROM ${table}
               WHERE ${claimable} AND ${dueAt} <= now()) AS due,
             (SELECT min(created_at) FROM ${table}
               WHERE ${claimable} AND ${dueAt} <= now()) AS oldest_due,
             (SELECT count(*) FROM ${table} WHERE ${leased}) AS leased,
             (SELECT count(*) FROM ${table} WHERE ${deadLetter}) AS dead_lettered,
             (SELECT count(*) FROM ${table}
               WHERE ${deadLetter} AND dead_lettered_at > now() - $1::interval)
               AS recent_dead_lettered`;

    return this.query<QueueGauge>(
      `WITH combined AS (
         ${queue(
           'inbound',
           'inbound_events',
           inboundClaimable,
           'COALESCE(next_attempt_at, created_at)',
           `status IN ('leased','processing')`,
           `status = 'dead_letter'`,
         )}
         UNION ALL
         ${queue(
           'outbound',
           'outbound_events',
           outboundClaimable,
           'COALESCE(next_attempt_at, scheduled_at, created_at)',
           `status IN ('leased','sending')`,
           `status = 'dead_letter'`,
         )}
         UNION ALL
         ${queue(
           'sync',
           'sync_jobs',
           syncClaimable,
           'COALESCE(next_attempt_at, rate_limited_until, created_at)',
           `is_deleted = false AND status = 'running'`,
           `is_deleted = false AND status = 'dead_letter'`,
         )}
       )
       SELECT queue,
              depth::int                                              AS "depth",
              due::int                                                AS "due",
              CASE WHEN oldest_due IS NULL THEN NULL
                   ELSE floor(EXTRACT(EPOCH FROM (now() - oldest_due)))::int
              END                                                     AS "oldestDueAgeSeconds",
              leased::int                                             AS "leased",
              dead_lettered::int                                      AS "deadLettered",
              recent_dead_lettered::int                               AS "recentDeadLettered"
         FROM combined
        ORDER BY queue`,
      // Postgres has no parameter form for an interval literal, so it arrives as
      // a string and is cast. Milliseconds keeps the constant in one unit.
      [`${DEAD_LETTER_ALERT_WINDOW_MS} milliseconds`],
    );
  }
}
