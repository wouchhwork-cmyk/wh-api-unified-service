import { Injectable } from '@nestjs/common';
import { MetaUsageMeter } from '@/shared/enums';
import { BaseRepository } from './base.repository';

/** One minute's accumulated usage for one pool, ready to be written. */
export interface MetaUsageBucket {
  readonly scopeKey: string;
  readonly meter: MetaUsageMeter;
  readonly product: string | null;
  readonly metaBusinessId: string | null;
  readonly enterpriseId: number | null;
  readonly channelId: number | null;
  readonly bucketStart: Date;
  readonly calls: number;
  readonly throttledCalls: number;
  readonly failedCalls: number;
  readonly callPct: number | null;
  readonly cpuPct: number | null;
  readonly timePct: number | null;
  readonly regainMinutes: number | null;
  readonly lastSeenAt: Date;
}

/** Which channel, and whose, a Meta id belongs to. */
export interface MetaScopeOwner {
  readonly platformChannelId: string;
  readonly channelId: number;
  readonly enterpriseId: number;
}

/** The newest reading for one pool, with whatever we know about whose it is. */
export interface MetaUsageCurrentRow {
  readonly scopeKey: string;
  readonly meter: MetaUsageMeter;
  readonly product: string | null;
  readonly metaBusinessId: string | null;
  readonly enterpriseId: number | null;
  readonly enterpriseName: string | null;
  readonly enterpriseRefId: string | null;
  readonly channelId: number | null;
  readonly channelName: string | null;
  readonly channelPlatform: string | null;
  readonly platformChannelId: string | null;
  readonly callPct: number | null;
  readonly cpuPct: number | null;
  readonly timePct: number | null;
  readonly regainMinutes: number | null;
  readonly lastSeenAt: Date;
  /**
   * Our own counts over BOTH of Meta's window sizes, not just the newest
   * minute.
   *
   * Two windows rather than one because Meta meters over two: the app pool is
   * hourly, the business pools are daily. Totalling a daily pool over an hour
   * would report a fraction of what that pool's percentage reflects, and the
   * two numbers side by side would quietly contradict each other.
   */
  readonly hourCalls: number;
  readonly hourThrottledCalls: number;
  readonly hourFailedCalls: number;
  readonly dayCalls: number;
  readonly dayThrottledCalls: number;
  readonly dayFailedCalls: number;
  /**
   * Refusals in the NEWEST minute only.
   *
   * Separate from the window totals because status needs recency and volume
   * does not. Driving "is this pool throttled" from a day-wide count means one
   * refusal at breakfast paints a pool red until breakfast tomorrow, long after
   * Meta went back to reporting 3% — which is how a screen whose whole purpose
   * is to be believed stops being believed.
   */
  readonly latestThrottledCalls: number;
}

/** One minute of one pool, for a chart. */
export interface MetaUsagePointRow {
  readonly scopeKey: string;
  readonly bucketStart: Date;
  readonly callPct: number | null;
  readonly calls: number;
  readonly throttledCalls: number;
}

/**
 * The rate-limit monitor's storage.
 *
 * DELIBERATELY NOT TENANT-SCOPED, and the only repository here of which that is
 * true besides the queue gauges. Two reasons it is safe: the rows contain no
 * customer data, only counts and percentages; and the one consumer is the
 * platform console, which is gated on platform staff rather than on any
 * enterprise role. `enterpriseId` is present so staff can attribute usage, not
 * so a tenant can read its own — nothing in the tenant-facing API touches this.
 */
@Injectable()
export class MetaApiUsageRepository extends BaseRepository {
  /**
   * Folds a flush into the minute's rows.
   *
   * COUNTS ADD, PERCENTAGES TAKE THE HIGHEST, and that difference is the whole
   * design. Our call counts are contributions — two processes each calling
   * thirty times made sixty calls — so they sum, which also makes the write
   * correct across replicas without any coordination. Meta's percentages are
   * observations of one global position, so summing them would be nonsense; the
   * highest seen in the minute is kept, because the worst position reached is
   * the one worth alarming on.
   *
   * `GREATEST` is used rather than a CASE because Postgres ignores NULLs in it:
   * a flush that carries no reading leaves an existing percentage alone instead
   * of erasing it.
   */
  async record(buckets: readonly MetaUsageBucket[]): Promise<number> {
    if (buckets.length === 0) return 0;

    const COLUMNS = 15;
    const values: unknown[] = [];
    const tuples = buckets.map((bucket, index) => {
      const at = index * COLUMNS;
      values.push(
        bucket.scopeKey,
        bucket.meter,
        bucket.product,
        bucket.metaBusinessId,
        bucket.enterpriseId,
        bucket.channelId,
        bucket.bucketStart,
        bucket.calls,
        bucket.throttledCalls,
        bucket.failedCalls,
        bucket.callPct,
        bucket.cpuPct,
        bucket.timePct,
        bucket.regainMinutes,
        bucket.lastSeenAt,
      );
      const placeholder = (offset: number): string => `$${at + offset}`;
      return (
        `(${placeholder(1)}, ${placeholder(2)}, ${placeholder(3)}, ${placeholder(4)}, ` +
        `${placeholder(5)}::bigint, ${placeholder(6)}::bigint, ${placeholder(7)}::timestamptz, ` +
        `${placeholder(8)}::int, ${placeholder(9)}::int, ${placeholder(10)}::int, ` +
        `${placeholder(11)}::smallint, ${placeholder(12)}::smallint, ${placeholder(13)}::smallint, ` +
        `${placeholder(14)}::int, ${placeholder(15)}::timestamptz)`
      );
    });

    const result = await this.mutate(
      `INSERT INTO meta_api_usage
         (scope_key, meter, product, meta_business_id, enterprise_id, channel_id,
          bucket_start, calls, throttled_calls, failed_calls,
          call_pct, cpu_pct, time_pct, regain_minutes, last_seen_at)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (scope_key, bucket_start) DO UPDATE SET
         calls           = meta_api_usage.calls           + EXCLUDED.calls,
         throttled_calls = meta_api_usage.throttled_calls + EXCLUDED.throttled_calls,
         failed_calls    = meta_api_usage.failed_calls    + EXCLUDED.failed_calls,
         call_pct        = GREATEST(meta_api_usage.call_pct,  EXCLUDED.call_pct),
         cpu_pct         = GREATEST(meta_api_usage.cpu_pct,   EXCLUDED.cpu_pct),
         time_pct        = GREATEST(meta_api_usage.time_pct,  EXCLUDED.time_pct),
         regain_minutes  = GREATEST(meta_api_usage.regain_minutes, EXCLUDED.regain_minutes),
         last_seen_at    = GREATEST(meta_api_usage.last_seen_at,   EXCLUDED.last_seen_at),
         /*
          * Attribution is FIRST-WINS, not last-wins, and the argument order is
          * the whole difference.
          *
          * Either way a later flush with nulls cannot blank a name the console
          * is showing — that was the original point. But
          * COALESCE(EXCLUDED, existing) also let a later NON-NULL value
          * replace a different one, and two replicas can disagree: a Meta
          * Business shared across tenants resolves to enterprise 1 in one
          * process and enterprise 2 in another, depending on which sibling
          * account each cache had seen. Last-wins made the row flip between
          * them, so a pool's owner changed every few seconds on screen.
          *
          * First-wins is stable instead. The residual limitation is stated
          * rather than hidden: an early attribution that was unambiguous in its
          * own bucket, but is genuinely shared, sticks — the collector refuses
          * to guess when it can see the ambiguity, and it cannot see across
          * processes.
          */
         enterprise_id   = COALESCE(meta_api_usage.enterprise_id, EXCLUDED.enterprise_id),
         channel_id      = COALESCE(meta_api_usage.channel_id,    EXCLUDED.channel_id),
         product         = COALESCE(EXCLUDED.product,       meta_api_usage.product),
         updated_at      = now()
       RETURNING id`,
      values,
    );
    /*
     * RETURNING is not decoration. `mutate` documents that an INSERT without it
     * comes back as a bare array, so `affected` is the length of an empty
     * result — zero — however many rows were written. The count is reported to
     * the flush log, and a monitor whose own success metric always reads zero
     * is not a monitor anybody will trust.
     */
    return result.rows.length;
  }

  /**
   * Which of Meta's ids are channels of ours.
   *
   * This is how usage is attributed without threading a tenant through every
   * Graph call: Meta keys the business header by the very id we store as
   * `platform_channel_id`, verified live for both a Page and an Instagram
   * account. An id that matches nothing is a Meta Business that owns assets we
   * touch but is not itself one of them, and stays unattributed.
   */
  async resolveOwners(platformChannelIds: readonly string[]): Promise<MetaScopeOwner[]> {
    if (platformChannelIds.length === 0) return [];
    return this.query<MetaScopeOwner>(
      `SELECT platform_channel_id AS "platformChannelId",
              id::int             AS "channelId",
              enterprise_id::int  AS "enterpriseId"
         FROM channels
        WHERE is_deleted = false
          AND platform_channel_id = ANY($1::varchar[])`,
      [[...platformChannelIds]],
    );
  }

  /**
   * The newest reading for every pool, with our own volume over both windows.
   *
   * ONE PASS, using window functions rather than two CTEs over the same rows.
   * The obvious shape — a `recent` CTE that `latest` and `totals` both select
   * from — reads beautifully and is materialised: Postgres 12+ materialises any
   * CTE referenced more than once, so `DISTINCT ON` then sorts a tuplestore
   * where no index exists. Confirmed with EXPLAIN, which showed a Sort over a
   * CTE Scan. On a dashboard polling every twenty seconds that is a full sort
   * of pools x 1440 rows, every time, for every open tab.
   *
   * `row_number()` picks the newest row per pool and the windowed `sum`s carry
   * the totals alongside it, from a single scan of the same filtered set.
   */
  async current(limit: number): Promise<MetaUsageCurrentRow[]> {
    return this.query<MetaUsageCurrentRow>(
      `WITH ranked AS (
         SELECT u.*,
                row_number() OVER (PARTITION BY u.scope_key ORDER BY u.bucket_start DESC) AS rn,
                sum(u.calls) FILTER (WHERE u.bucket_start > now() - interval '1 hour')
                  OVER (PARTITION BY u.scope_key) AS hour_calls,
                sum(u.throttled_calls) FILTER (WHERE u.bucket_start > now() - interval '1 hour')
                  OVER (PARTITION BY u.scope_key) AS hour_throttled,
                sum(u.failed_calls) FILTER (WHERE u.bucket_start > now() - interval '1 hour')
                  OVER (PARTITION BY u.scope_key) AS hour_failed,
                sum(u.calls)           OVER (PARTITION BY u.scope_key) AS day_calls,
                sum(u.throttled_calls) OVER (PARTITION BY u.scope_key) AS day_throttled,
                sum(u.failed_calls)    OVER (PARTITION BY u.scope_key) AS day_failed
           FROM meta_api_usage u
          WHERE u.bucket_start > now() - interval '24 hours'
       )
       SELECT r.scope_key                       AS "scopeKey",
              r.meter                           AS "meter",
              r.product                         AS "product",
              r.meta_business_id                AS "metaBusinessId",
              r.enterprise_id::int              AS "enterpriseId",
              e.name                            AS "enterpriseName",
              e.ref_id                          AS "enterpriseRefId",
              r.channel_id::int                 AS "channelId",
              COALESCE(c.name, c.username)      AS "channelName",
              c.platform                        AS "channelPlatform",
              c.platform_channel_id             AS "platformChannelId",
              r.call_pct                        AS "callPct",
              r.cpu_pct                         AS "cpuPct",
              r.time_pct                        AS "timePct",
              r.regain_minutes                  AS "regainMinutes",
              r.last_seen_at                    AS "lastSeenAt",
              r.throttled_calls                 AS "latestThrottledCalls",
              COALESCE(r.hour_calls, 0)::int    AS "hourCalls",
              COALESCE(r.hour_throttled, 0)::int AS "hourThrottledCalls",
              COALESCE(r.hour_failed, 0)::int   AS "hourFailedCalls",
              COALESCE(r.day_calls, 0)::int     AS "dayCalls",
              COALESCE(r.day_throttled, 0)::int AS "dayThrottledCalls",
              COALESCE(r.day_failed, 0)::int    AS "dayFailedCalls"
         FROM ranked r
         LEFT JOIN enterprises e ON e.id = r.enterprise_id
         LEFT JOIN channels c    ON c.id = r.channel_id
        WHERE r.rn = 1
        ORDER BY r.call_pct DESC NULLS LAST, r.scope_key
        LIMIT $1`,
      [limit],
    );
  }

  /**
   * Minute-by-minute history for charting.
   *
   * Bounded by BOTH a time window and a row cap: an unbounded series is how a
   * monitoring endpoint becomes the thing that needs monitoring.
   */
  async history(
    windowMs: number,
    maxPoints: number,
    scopeKey: string | null,
  ): Promise<MetaUsagePointRow[]> {
    return this.query<MetaUsagePointRow>(
      `SELECT scope_key        AS "scopeKey",
              bucket_start     AS "bucketStart",
              call_pct         AS "callPct",
              calls            AS "calls",
              throttled_calls  AS "throttledCalls"
         FROM meta_api_usage
        WHERE bucket_start > now() - $1::interval
          AND ($3::varchar IS NULL OR scope_key = $3)
        /*
         * scope_key is the tiebreaker, and it is not decoration. Without it
         * every pool's rows share a bucket_start, so the cut at the boundary
         * minute is arbitrary and moves between calls — a chart that redraws
         * differently on each poll for no reason anybody can see.
         */
        ORDER BY bucket_start DESC, scope_key
        LIMIT $2`,
      [`${windowMs} milliseconds`, maxPoints, scopeKey],
    );
  }

  /**
   * Drops history past the retention window.
   *
   * Matches `meta_api_usage_bucket_start_idx`, which is the one index here left
   * deliberately non-partial so this sweep can reach every row — including the
   * app-meter and unattributed ones the enterprise index excludes.
   */
  async sweep(olderThanMs: number, limit: number): Promise<number> {
    const result = await this.mutate(
      `DELETE FROM meta_api_usage
        WHERE id IN (
          SELECT id FROM meta_api_usage
           WHERE bucket_start < now() - $1::interval
           ORDER BY bucket_start
           LIMIT $2
        )`,
      [`${olderThanMs} milliseconds`, limit],
    );
    return result.affected;
  }
}
