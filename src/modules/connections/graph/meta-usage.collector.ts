import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  MetaApiUsageRepository,
  type MetaUsageBucket,
} from '@/database/repositories/meta-api-usage.repository';
import {
  META_USAGE_BUCKET_MS,
  META_USAGE_FLUSH_MS,
  META_USAGE_MAX_PENDING_BUCKETS,
  META_USAGE_SCOPE_CACHE_MS,
} from '@/shared/constants';
import { MetaUsageMeter } from '@/shared/enums';
import type { MetaUsageReading } from './graph-usage.parser';

/** What one Graph call produced, from the monitor's point of view. */
export interface MetaUsageObservation {
  readonly readings: readonly MetaUsageReading[];
  /** Meta refused this call for rate limiting. */
  readonly throttled: boolean;
  /** The call failed for any other reason. */
  readonly failed: boolean;
}

/** A minute of one pool, still being accumulated. */
interface PendingBucket {
  scopeKey: string;
  meter: MetaUsageMeter;
  product: string | null;
  metaBusinessId: string | null;
  bucketStartMs: number;
  calls: number;
  throttledCalls: number;
  failedCalls: number;
  callPct: number | null;
  cpuPct: number | null;
  timePct: number | null;
  regainMinutes: number | null;
  lastSeenMs: number;
  /**
   * The OTHER Meta ids named on the same responses as this pool.
   *
   * Instagram reports a single read under two ids — the account, which is one
   * of our channels, and the owning Meta Business, which is not. Without this
   * the business-level pool could never be attributed to anybody, and it is the
   * one that actually throttles. See `inferEnterprise`.
   */
  siblingIds: Set<string>;
}

/** A resolved owner, or an id we have looked up and know is not ours. */
interface CachedOwner {
  readonly channelId: number | null;
  readonly enterpriseId: number | null;
  readonly cachedAtMs: number;
}

const APP_SCOPE_KEY = 'app';

/**
 * Where a call with NO usage header is counted.
 *
 * NOT the app pool, which is what it used to be and was wrong in the way that
 * matters most. The app meter and the business meters are mutually exclusive —
 * a Page-token inbox call never touches the app pool — so a timeout on one of
 * those was writing an `app` row with a NULL percentage. Because the console
 * reads the LATEST row per pool, one timed-out inbox call blanked the app gauge
 * to "unknown", and a pool sitting at 95% silently dropped off the needs-
 * attention banner because of something unrelated to it.
 *
 * A call we learned nothing about is still a call we made, so it is counted —
 * just under its own name, where it cannot overwrite a real reading.
 */
const UNKNOWN_SCOPE_KEY = 'unknown';

/**
 * The widest a scope key can be. `scope_key` is VARCHAR(120); a Meta business
 * id plus a product is far shorter, but neither is ours to bound, and an
 * over-long one would abort the whole flush rather than just itself.
 */
const MAX_SCOPE_KEY_LENGTH = 120;

/**
 * Keeps a running account of how much of Meta's rate limit we have spent.
 *
 * WHY IT BUFFERS. Every Graph response carries a usage header, and the obvious
 * implementation — write the reading when it arrives — puts a database round
 * trip on the path of every platform call. A backfill making two hundred calls
 * a minute would pay two hundred writes to record a number that only changes in
 * whole percentage points. So readings accumulate in memory and are folded into
 * the minute's row on a timer: one UPSERT per pool per flush, however busy.
 *
 * WHY IT CANNOT THROW. This is an observer. `observe` does no I/O, catches
 * nothing because it can fail at nothing, and returns void — a monitor that can
 * break the thing it monitors is worse than no monitor. The flush swallows its
 * own errors for the same reason, loudly.
 *
 * ACROSS PROCESSES. The API and the workers both make Graph calls and each has
 * its own buffer. That is correct without coordination: call counts are summed
 * by the UPSERT, and percentages take the highest — Meta's figures are a global
 * position, so two processes reading 40% have not between them used 80%.
 */
@Injectable()
export class MetaUsageCollector implements OnModuleInit, OnApplicationShutdown {
  private readonly pending = new Map<string, PendingBucket>();
  private readonly owners = new Map<string, CachedOwner>();
  private timer: NodeJS.Timeout | null = null;
  /** Buckets dropped because the buffer was full, reported once per flush. */
  private dropped = 0;

  constructor(
    private readonly usage: MetaApiUsageRepository,
    @InjectPinoLogger(MetaUsageCollector.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, META_USAGE_FLUSH_MS);
    // Nothing should be held open by a monitor: an empty process must still be
    // able to exit.
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // The last flush matters more than the others: a graceful restart during a
    // backfill would otherwise lose the minute in which it was throttled.
    await this.flush();
  }

  /**
   * Records one Graph call. Synchronous, non-blocking, never throws.
   *
   * An observation with NO readings is still recorded — Meta omitting the
   * header is a real case, and our own call count is the only thing that stays
   * true through it — but under its OWN scope rather than the app pool. See
   * UNKNOWN_SCOPE_KEY.
   */
  observe(observation: MetaUsageObservation): void {
    const nowMs = Date.now();
    const bucketStartMs = Math.floor(nowMs / META_USAGE_BUCKET_MS) * META_USAGE_BUCKET_MS;

    const named = observation.readings.filter(
      (reading) => reading.meter === MetaUsageMeter.BusinessUseCase && reading.metaBusinessId,
    );
    const siblingIds = named.map((reading) => reading.metaBusinessId as string);

    if (observation.readings.length === 0) {
      /*
       * Its own scope, never the app pool. See UNKNOWN_SCOPE_KEY: a timeout on
       * a Page-token call touched no app allowance, and recording it there
       * blanked a gauge that was reading perfectly well.
       */
      this.fold(
        {
          scopeKey: UNKNOWN_SCOPE_KEY,
          meter: MetaUsageMeter.Unknown,
          product: null,
          metaBusinessId: null,
        },
        observation,
        null,
        bucketStartMs,
        nowMs,
        [],
      );
      return;
    }

    for (const reading of observation.readings) {
      const scopeKey =
        reading.meter === MetaUsageMeter.App
          ? APP_SCOPE_KEY
          : `${reading.metaBusinessId ?? 'unattributed'}:${reading.product ?? 'unknown'}`.slice(
              0,
              MAX_SCOPE_KEY_LENGTH,
            );

      this.fold(
        {
          scopeKey,
          meter: reading.meter,
          product: reading.product,
          metaBusinessId: reading.metaBusinessId,
        },
        observation,
        reading,
        bucketStartMs,
        nowMs,
        siblingIds,
      );
    }
  }

  private fold(
    identity: {
      scopeKey: string;
      meter: MetaUsageMeter;
      product: string | null;
      metaBusinessId: string | null;
    },
    observation: MetaUsageObservation,
    reading: MetaUsageReading | null,
    bucketStartMs: number,
    nowMs: number,
    siblingIds: readonly string[],
  ): void {
    const key = `${identity.scopeKey}|${bucketStartMs}`;
    let bucket = this.pending.get(key);

    if (!bucket) {
      if (this.pending.size >= META_USAGE_MAX_PENDING_BUCKETS) {
        /*
         * Losing monitoring beats an out-of-memory kill of a process that is
         * otherwise serving traffic.
         *
         * NOT reachable by a failing flush, which was the original claim and is
         * wrong: `flush` clears the buffer before it writes, so a rejected
         * write shrinks it rather than growing it. This needs more than
         * META_USAGE_MAX_PENDING_BUCKETS DISTINCT pools inside one flush
         * interval — which means Meta inventing scope keys, not us being busy.
         */
        this.dropped += 1;
        return;
      }
      bucket = {
        ...identity,
        bucketStartMs,
        calls: 0,
        throttledCalls: 0,
        failedCalls: 0,
        callPct: null,
        cpuPct: null,
        timePct: null,
        regainMinutes: null,
        lastSeenMs: nowMs,
        siblingIds: new Set<string>(),
      };
      this.pending.set(key, bucket);
    }

    bucket.calls += 1;
    if (observation.throttled) bucket.throttledCalls += 1;
    if (observation.failed) bucket.failedCalls += 1;
    bucket.lastSeenMs = Math.max(bucket.lastSeenMs, nowMs);

    if (reading) {
      // The HIGHEST seen in the minute, not the last: the worst position
      // reached is what the alarm is about. `highest` keeps a null when Meta
      // said nothing rather than treating silence as zero.
      bucket.callPct = highest(bucket.callPct, reading.callPct);
      bucket.cpuPct = highest(bucket.cpuPct, reading.cpuPct);
      bucket.timePct = highest(bucket.timePct, reading.timePct);
      bucket.regainMinutes = highest(bucket.regainMinutes, reading.regainMinutes);
      if (reading.product && !bucket.product) bucket.product = reading.product;
    }

    for (const sibling of siblingIds) {
      if (sibling !== identity.metaBusinessId) bucket.siblingIds.add(sibling);
    }
  }

  /**
   * Writes what has accumulated, resolves attribution, and forgets it.
   *
   * The buffer is TAKEN FIRST and cleared, so calls arriving during the write
   * land in a fresh buffer rather than being lost or double-counted. If the
   * write fails the taken buckets are gone — deliberately: retrying monitoring
   * data would grow the buffer during exactly the incident that broke the
   * database, and the next flush reports the current position anyway.
   */
  async flush(): Promise<void> {
    if (this.pending.size === 0) {
      this.reportDrops();
      return;
    }

    const taken = [...this.pending.values()];
    this.pending.clear();

    try {
      const owners = await this.resolveOwners(taken);
      await this.usage.record(taken.map((bucket) => this.toRow(bucket, owners)));
    } catch (error) {
      this.logger.error(
        { err: error, buckets: taken.length },
        'could not record Meta rate-limit usage; this flush is lost',
      );
    }
    this.reportDrops();
  }

  private reportDrops(): void {
    if (this.dropped === 0) return;
    this.logger.warn(
      { dropped: this.dropped },
      'rate-limit buffer was full; usage readings were discarded',
    );
    this.dropped = 0;
  }

  /**
   * Which Meta ids belong to which of our channels.
   *
   * Cached, because the answer changes only when a business connects or
   * disconnects and this would otherwise be a query per flush. Ids that resolve
   * to nothing are cached too — a Meta Business id is not one of our channels
   * and never will be, and re-asking every fifteen seconds is the sort of thing
   * that makes a monitor cost more than what it monitors.
   */
  private async resolveOwners(
    buckets: readonly PendingBucket[],
  ): Promise<ReadonlyMap<string, CachedOwner>> {
    const nowMs = Date.now();
    const wanted = new Set<string>();
    for (const bucket of buckets) {
      if (bucket.metaBusinessId) wanted.add(bucket.metaBusinessId);
      for (const sibling of bucket.siblingIds) wanted.add(sibling);
    }

    const stale = [...wanted].filter((id) => {
      const cached = this.owners.get(id);
      return !cached || nowMs - cached.cachedAtMs > META_USAGE_SCOPE_CACHE_MS;
    });

    if (stale.length > 0) {
      const rows = await this.usage.resolveOwners(stale);
      const found = new Map(rows.map((row) => [row.platformChannelId, row]));
      for (const id of stale) {
        const row = found.get(id);
        this.owners.set(id, {
          channelId: row?.channelId ?? null,
          enterpriseId: row?.enterpriseId ?? null,
          cachedAtMs: nowMs,
        });
      }
    }

    return this.owners;
  }

  private toRow(bucket: PendingBucket, owners: ReadonlyMap<string, CachedOwner>): MetaUsageBucket {
    const direct = bucket.metaBusinessId ? owners.get(bucket.metaBusinessId) : undefined;
    const channelId = direct?.channelId ?? null;
    const enterpriseId = direct?.enterpriseId ?? this.inferEnterprise(bucket, owners);

    return {
      scopeKey: bucket.scopeKey,
      meter: bucket.meter,
      product: bucket.product,
      metaBusinessId: bucket.metaBusinessId,
      enterpriseId,
      channelId,
      bucketStart: new Date(bucket.bucketStartMs),
      calls: bucket.calls,
      throttledCalls: bucket.throttledCalls,
      failedCalls: bucket.failedCalls,
      callPct: bucket.callPct,
      cpuPct: bucket.cpuPct,
      timePct: bucket.timePct,
      regainMinutes: bucket.regainMinutes,
      lastSeenAt: new Date(bucket.lastSeenMs),
    };
  }

  /**
   * Whose pool this is, when the id itself is not one of our channels.
   *
   * A Meta Business id appears alongside the account id on the same response,
   * so the business-level pool can be attributed to the enterprise that owns
   * the account named next to it. ONLY WHEN UNAMBIGUOUS: if a minute's
   * responses tie this pool to two different businesses of ours, it genuinely
   * is shared and claiming either would be a lie. It stays unattributed and the
   * dashboard shows it under its Meta id, which is the truth.
   */
  private inferEnterprise(
    bucket: PendingBucket,
    owners: ReadonlyMap<string, CachedOwner>,
  ): number | null {
    const candidates = new Set<number>();
    for (const sibling of bucket.siblingIds) {
      const enterpriseId = owners.get(sibling)?.enterpriseId;
      if (typeof enterpriseId === 'number') candidates.add(enterpriseId);
    }
    return candidates.size === 1 ? [...candidates][0]! : null;
  }
}

/**
 * The larger of two figures, where null means "not observed".
 *
 * Not `Math.max`: `Math.max(null, 5)` is 5 only because null coerces to 0, and
 * the same coercion would silently turn an unobserved percentage into a real
 * reading of zero the moment anything compared against it.
 */
function highest(existing: number | null, incoming: number | null): number | null {
  if (incoming === null) return existing;
  if (existing === null) return incoming;
  return Math.max(existing, incoming);
}
