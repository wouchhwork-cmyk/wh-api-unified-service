import { Check, Column, Entity, Index } from 'typeorm';
import { MetaUsageMeter } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';
import { TIMESTAMP_PRECISION } from '../timestamp-precision';

/**
 * What Meta has told us about how much of its rate limit we have spent.
 *
 * ONE ROW PER SCOPE PER MINUTE, upserted. Every Graph response carries a usage
 * header; writing a row per call would put a database round trip on the path of
 * every platform call, so readings are aggregated in memory and folded into the
 * minute's row on a timer (MetaUsageCollector).
 *
 * TWO KINDS OF NUMBER LIVE HERE, and confusing them is the trap this table
 * exists to avoid:
 *
 *   - `callPct`, `cpuPct`, `timePct` are META'S, and they are PERCENTAGES of an
 *     allowance whose absolute size Meta never states. They are authoritative
 *     for "how close are we to being refused" and useless for "how many calls
 *     did we make".
 *   - `calls`, `throttledCalls`, `failedCalls` are OURS, counted locally. They
 *     are authoritative for volume and say nothing about the limit.
 *
 * Neither can be derived from the other, which is why both are stored. The
 * allowance is a function of the business's own audience — `4800 x impressions`
 * for Instagram, `200 x engaged users` for Messenger — so two businesses making
 * identical numbers of calls can sit at wildly different percentages, and a
 * quiet account is the one most likely to be throttled.
 *
 * NOT tenant-scoped in the BaseRepository sense: this is platform-operations
 * data, read only by platform staff. `enterpriseId` and `channelId` are
 * attribution, resolved from the ids Meta names in the header, and are NULL
 * when the id is the app meter or a business we cannot match to a channel.
 */
@Entity('meta_api_usage')
@Index('meta_api_usage_bucket_uniq', ['scopeKey', 'bucketStart'], { unique: true })
// The retention sweep and the history chart. Declared here as well as in the
// migration for the reason the CHECKs below are: an index in only one of the
// two build paths does not exist where the tests run.
@Index('meta_api_usage_bucket_start_idx', ['bucketStart'])
/*
 * DECLARED HERE AS WELL AS IN THE MIGRATION, and they have to be.
 *
 * The schema is built two ways — migrations for deployed environments, `db:sync`
 * from these entities for development and the test databases — and
 * `schema-parity.spec.ts` compares them. A constraint written only in the
 * migration silently does not exist where the tests run, so the test that proves
 * it works passes against a table that does not have it.
 *
 * The upper bound is 1000 rather than 100 on purpose: 100 is where Meta starts
 * throttling, not where it stops counting, and a pool reported at 140% is a real
 * reading we would rather store than reject.
 */
@Check('meta_api_usage_call_pct_chk', 'call_pct IS NULL OR (call_pct BETWEEN 0 AND 1000)')
@Check('meta_api_usage_cpu_pct_chk', 'cpu_pct IS NULL OR (cpu_pct BETWEEN 0 AND 1000)')
@Check('meta_api_usage_time_pct_chk', 'time_pct IS NULL OR (time_pct BETWEEN 0 AND 1000)')
@Check(
  'meta_api_usage_counts_chk',
  'calls >= 0 AND throttled_calls >= 0 AND failed_calls >= 0',
)
export class MetaApiUsage extends BaseEntity {
  /**
   * The identity of the pool being measured, and the conflict target.
   *
   * `app` for the single app-wide meter; `{metaBusinessId}:{product}` for a
   * business-use-case pool. It is a composed string rather than a set of
   * nullable columns because ON CONFLICT cannot use a unique index over columns
   * that are NULL — in Postgres two NULLs are distinct, so every flush would
   * insert a new row instead of folding into the minute's.
   */
  @Column({ type: 'varchar', length: 120 })
  scopeKey!: string;

  /** Which of Meta's two metering systems reported this. */
  @Column({ type: 'varchar', length: 30 })
  meter!: MetaUsageMeter;

  /**
   * Meta's `type` — which product pool of that business was drawn on.
   *
   * NULL for the app meter, which has no product breakdown. Stored as free text
   * rather than a constrained enum: Meta adds values, and a pool we cannot name
   * is still a pool that can throttle us.
   */
  @Column({ type: 'varchar', length: 40, nullable: true })
  product!: string | null;

  /**
   * The id Meta keyed this entry under. NULL for the app meter.
   *
   * Sometimes one of our `channels.platform_channel_id` values, sometimes the
   * owning Meta Business id — a single Instagram read reports under BOTH, which
   * is why this is stored verbatim and attribution is a separate question.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  metaBusinessId!: string | null;

  /**
   * Which business's work drew on this pool, where we could tell.
   *
   * NULL for the app meter and for any Meta id we could not attribute. No
   * foreign key: attribution is best-effort observability, and a channel that
   * is later deleted must not take its usage history with it or block the
   * delete.
   */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  enterpriseId!: number | null;

  /** The channel, where the id Meta named was one of ours. NULL otherwise. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  channelId!: number | null;

  /** Start of the minute this row aggregates. */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION })
  bucketStart!: Date;

  /** Calls WE made against this pool in this minute. Ours, not Meta's. */
  @Column({ type: 'int', default: 0 })
  calls!: number;

  /**
   * Calls Meta refused for rate limiting.
   *
   * Worth its own column rather than inferring from the percentage: Meta's
   * guidance is that calling while throttled extends the block, so a non-zero
   * value here is the signal that something is making the problem worse.
   */
  @Column({ type: 'int', default: 0 })
  throttledCalls!: number;

  /** Calls that failed for any other reason. Context for a rising percentage. */
  @Column({ type: 'int', default: 0 })
  failedCalls!: number;

  /**
   * Meta's percentage of the CALL allowance used, highest seen in this minute.
   *
   * The highest rather than the last, because the point of the row is the worst
   * position we reached. NULL means Meta sent no header — which is NOT zero:
   * the documentation says the header appears on endpoints receiving enough
   * requests, so absence is "unknown", and treating it as zero would report a
   * clear budget at the exact moment we stopped being able to see it.
   */
  @Column({ type: 'smallint', nullable: true })
  callPct!: number | null;

  /** Percentage of the CPU-time allowance. Same rules as `callPct`. */
  @Column({ type: 'smallint', nullable: true })
  cpuPct!: number | null;

  /** Percentage of the total-time allowance. Same rules as `callPct`. */
  @Column({ type: 'smallint', nullable: true })
  timePct!: number | null;

  /**
   * Meta's own estimate of the minutes until calls stop being refused.
   *
   * Only meaningful once actually throttled. Meta reports 0 on pools sitting at
   * 95% and 97%, so this field means "not currently blocked", never "safe" —
   * the percentage is what says how much room is left.
   */
  @Column({ type: 'int', nullable: true })
  regainMinutes!: number | null;

  /** The most recent response folded into this row. */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION })
  lastSeenAt!: Date;
}
