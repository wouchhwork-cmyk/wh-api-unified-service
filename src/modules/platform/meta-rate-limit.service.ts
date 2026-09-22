import { Injectable } from '@nestjs/common';
import {
  MetaApiUsageRepository,
  type MetaUsageCurrentRow,
} from '@/database/repositories/meta-api-usage.repository';
import {
  MAX_MONITORED_POOLS,
  META_USAGE_THROTTLE_PCT,
  META_USAGE_WARN_PCT,
} from '@/shared/constants';
import { MetaUsageMeter, MetaUsageProduct } from '@/shared/enums';

/**
 * How close a pool is to being refused.
 *
 * `unknown` is a first-class value, not a failure. Meta documents that the
 * usage header appears on endpoints receiving enough requests, so a pool we
 * have called but heard nothing about is genuinely unmeasured — and showing
 * that as a healthy 0% would put a green light on the one pool nobody can see.
 */
export type MetaPoolStatus = 'ok' | 'warning' | 'throttled' | 'unknown';

/** One metered pool, as the console shows it. */
export interface MetaPoolView {
  readonly scopeKey: string;
  readonly meter: MetaUsageMeter;
  readonly product: string | null;
  readonly metaBusinessId: string | null;
  readonly status: MetaPoolStatus;

  /**
   * The highest of Meta's three percentages, which is the one that decides.
   *
   * Calls, CPU time and total time are metered separately and ANY of them
   * reaching 100 throttles the pool, so the headline number is the worst of the
   * three rather than the call count everybody looks at.
   */
  readonly usedPercent: number | null;
  /** 100 minus the above. NULL when Meta has told us nothing. */
  readonly remainingPercent: number | null;
  readonly callPercent: number | null;
  readonly cpuPercent: number | null;
  readonly timePercent: number | null;

  /** Meta's rolling window for this pool, in minutes. */
  readonly windowMinutes: number;
  /** The published formula, so a number on screen can be reasoned about. */
  readonly allowanceFormula: string;
  /**
   * What the allowance appears to be in whole calls, inferred from our own
   * count against Meta's percentage.
   *
   * AN ESTIMATE, AND MARKED AS ONE. Meta states the formula but never the
   * resulting number, so this is the only way to get one — and it is only
   * offered when the arithmetic is stable: the percentage is a whole number, so
   * at 1% the error bar is the width of the estimate itself. NULL means we
   * decline to guess, which is the honest answer more often than not.
   */
  readonly estimatedAllowanceCalls: number | null;

  /** Ours, over this pool's own window. Volume, not position. */
  readonly callsInWindow: number;
  readonly throttledCallsInWindow: number;
  readonly failedCallsInWindow: number;

  /** Meta's estimate of when it will accept calls again. Only once refused. */
  readonly regainMinutes: number | null;
  readonly throttledUntil: Date | null;
  readonly lastSeenAt: Date;

  readonly channel: {
    readonly name: string | null;
    readonly platform: string | null;
    readonly platformChannelId: string | null;
  } | null;
}

/** One minute of one pool, for a chart. */
export interface MetaUsagePoint {
  readonly scopeKey: string;
  readonly at: Date;
  readonly usedPercent: number | null;
  readonly calls: number;
  readonly throttledCalls: number;
}

/** Every pool belonging to one business. */
export interface MetaEnterpriseUsageView {
  readonly enterpriseRefId: string;
  readonly enterpriseName: string;
  readonly status: MetaPoolStatus;
  readonly pools: readonly MetaPoolView[];
}

export interface MetaRateLimitOverview {
  readonly generatedAt: Date;
  /**
   * The single app-wide pool, or null if nothing has drawn on it recently.
   *
   * Null is the ordinary state for a quiet deployment, not an error: the app
   * meter is only touched by the connect and token paths.
   */
  readonly app: MetaPoolView | null;
  readonly enterprises: readonly MetaEnterpriseUsageView[];
  /**
   * Pools Meta named under an id that is not one of our channels and could not
   * be tied to exactly one business.
   *
   * Usually a Meta Business that owns assets across more than one of our
   * tenants — genuinely shared quota, shown separately rather than attributed
   * to whichever tenant happened to be called first.
   */
  readonly unattributed: readonly MetaPoolView[];
  /** Pools at or past the warning line, worst first. What to look at. */
  readonly attention: readonly MetaPoolView[];
}

/** Meta's rolling window per pool, in minutes. */
const WINDOW_MINUTES: Record<string, number> = {
  [MetaUsageProduct.Instagram]: 24 * 60,
  [MetaUsageProduct.Messenger]: 24 * 60,
  [MetaUsageProduct.Pages]: 24 * 60,
  [MetaUsageProduct.LeadGen]: 24 * 60,
  [MetaUsageProduct.AdsInsights]: 60,
  [MetaUsageProduct.AdsManagement]: 60,
  [MetaUsageProduct.CustomAudience]: 60,
};

/** The published formula per pool. Shown so a percentage can be interpreted. */
const ALLOWANCE_FORMULA: Record<string, string> = {
  [MetaUsageProduct.Instagram]: '4800 × impressions, per 24 hours',
  [MetaUsageProduct.Messenger]: '200 × engaged users, per 24 hours',
  [MetaUsageProduct.Pages]: '4800 × engaged users, per 24 hours',
  [MetaUsageProduct.LeadGen]: '4800 × leads generated, per 24 hours',
};

const APP_WINDOW_MINUTES = 60;
/** Every business-use-case pool Meta meters is a 24-hour pool. */
const BUSINESS_WINDOW_MINUTES = 24 * 60;
const APP_FORMULA = '200 × daily active users, per hour';

/**
 * Below this percentage an inferred allowance is not worth showing.
 *
 * Meta reports whole numbers, so a pool at 1% could be anywhere from 0.5% to
 * 1.5% — an estimate built on it is wrong by a factor of three in either
 * direction. Ten percent brings that to about ±5%, which is honest enough to
 * put on a screen.
 */
const MIN_PERCENT_FOR_ESTIMATE = 10;

/**
 * Reads the rate-limit ledger for the platform console.
 *
 * WHAT THIS SERVICE IS REALLY FOR. Meta meters us in percentages of an
 * allowance it never states, over windows that differ by product, against
 * quotas that scale with each business's own audience. None of that is
 * legible from a raw row. The job here is to turn it into the two questions an
 * operator actually has — "is anything about to be refused" and "whose work is
 * spending it" — without inventing precision Meta did not give us.
 */
@Injectable()
export class MetaRateLimitService {
  constructor(private readonly usage: MetaApiUsageRepository) {}

  async overview(): Promise<MetaRateLimitOverview> {
    const rows = await this.usage.current(MAX_MONITORED_POOLS);
    const pools = rows.map((row) => this.toPool(row));

    const byEnterprise = new Map<string, { name: string; pools: MetaPoolView[] }>();
    const unattributed: MetaPoolView[] = [];
    let app: MetaPoolView | null = null;

    /*
     * Grouped from the ROWS, zipped with their views, because attribution lives
     * on the row and not on what the console is shown. Walking the views and
     * looking the row back up by index is the same thing written so that it
     * breaks the first time a filter reorders one side.
     */
    for (const [index, row] of rows.entries()) {
      const pool = pools[index]!;
      /*
       * ONLY a real app-meter reading becomes the app gauge.
       *
       * The headerless scope used to share this meter, which meant it landed
       * here — and because it carries no percentage it sorts last, so it
       * overwrote the genuine reading every single time. The fix that moved it
       * to its own scope key changed nothing until the meter moved with it.
       */
      if (row.meter === MetaUsageMeter.App) {
        app = pool;
        continue;
      }
      if (row.meter === MetaUsageMeter.Unknown) {
        // Shown, because these are calls we really made, but never presented as
        // a position in a pool — there is no pool it belongs to.
        unattributed.push(pool);
        continue;
      }
      if (row.enterpriseRefId && row.enterpriseName) {
        const existing = byEnterprise.get(row.enterpriseRefId);
        if (existing) existing.pools.push(pool);
        else byEnterprise.set(row.enterpriseRefId, { name: row.enterpriseName, pools: [pool] });
      } else {
        unattributed.push(pool);
      }
    }

    const enterprises: MetaEnterpriseUsageView[] = [...byEnterprise.entries()]
      .map(([enterpriseRefId, entry]) => ({
        enterpriseRefId,
        enterpriseName: entry.name,
        status: worstStatus(entry.pools),
        pools: [...entry.pools].sort(byUsedPercentDescending),
      }))
      // Worst business first: this list is read top-down when something is
      // wrong, and a business is only as healthy as its unhealthiest pool.
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

    const attention = pools
      .filter((pool) => pool.status === 'throttled' || pool.status === 'warning')
      .sort(byUsedPercentDescending);

    return {
      generatedAt: new Date(),
      app,
      enterprises,
      unattributed: unattributed.sort(byUsedPercentDescending),
      attention,
    };
  }

  /**
   * The series behind the chart, oldest first.
   *
   * Returned oldest-first although the query sorts newest-first: the LIMIT has
   * to keep the RECENT end when a window holds more points than the cap, and a
   * chart has to draw left to right. Reversing here is the only place that
   * reconciles the two, so neither the query nor the client has to know.
   */
  async history(input: {
    windowMinutes: number;
    limit: number;
    scopeKey: string | null;
  }): Promise<readonly MetaUsagePoint[]> {
    const rows = await this.usage.history(
      input.windowMinutes * 60 * 1000,
      input.limit,
      input.scopeKey,
    );
    return rows
      .map((row) => ({
        scopeKey: row.scopeKey,
        at: row.bucketStart,
        usedPercent: row.callPct,
        calls: row.calls,
        throttledCalls: row.throttledCalls,
      }))
      .reverse();
  }

  private toPool(row: MetaUsageCurrentRow): MetaPoolView {
    const isApp = row.meter === MetaUsageMeter.App;
    /*
     * An unrecognised product falls back to the BUSINESS window, not the app
     * one. Every business-use-case pool Meta meters runs over 24 hours, and the
     * enum says in as many words that Meta documents seven types today and adds
     * more. Falling back to 60 would label a day's percentage as an hour's and
     * would read the hour's call count beside it — understating the pool by up
     * to twenty-four times on the first day a new type appears.
     */
    const windowMinutes = isApp
      ? APP_WINDOW_MINUTES
      : (WINDOW_MINUTES[row.product ?? ''] ?? BUSINESS_WINDOW_MINUTES);

    // Over an hourly window the hour totals are the right ones; over a daily
    // window, the day's. Reading the wrong pair is how a daily pool comes to
    // show a hundredth of the calls its percentage was earned by.
    const useHour = windowMinutes <= APP_WINDOW_MINUTES;
    const calls = useHour ? row.hourCalls : row.dayCalls;
    const throttledCalls = useHour ? row.hourThrottledCalls : row.dayThrottledCalls;
    const failedCalls = useHour ? row.hourFailedCalls : row.dayFailedCalls;

    const usedPercent = highestOf(row.callPct, row.cpuPct, row.timePct);

    return {
      scopeKey: row.scopeKey,
      meter: row.meter,
      product: row.product,
      metaBusinessId: row.metaBusinessId,
      status: statusOf(usedPercent, row.latestThrottledCalls, row.regainMinutes),
      usedPercent,
      remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
      callPercent: row.callPct,
      cpuPercent: row.cpuPct,
      timePercent: row.timePct,
      windowMinutes,
      allowanceFormula: isApp
        ? APP_FORMULA
        : (ALLOWANCE_FORMULA[row.product ?? ''] ?? 'not published by Meta'),
      estimatedAllowanceCalls: estimateAllowance(calls, row.callPct),
      callsInWindow: calls,
      throttledCallsInWindow: throttledCalls,
      failedCallsInWindow: failedCalls,
      regainMinutes: row.regainMinutes,
      throttledUntil:
        row.regainMinutes === null || row.regainMinutes <= 0
          ? null
          : new Date(row.lastSeenAt.getTime() + row.regainMinutes * 60 * 1000),
      lastSeenAt: row.lastSeenAt,
      channel: row.channelId
        ? {
            name: row.channelName,
            platform: row.channelPlatform,
            platformChannelId: row.platformChannelId,
          }
        : null,
    };
  }
}

/** The worst of several figures, where null means "not observed". */
function highestOf(...values: readonly (number | null)[]): number | null {
  let highest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    highest = highest === null ? value : Math.max(highest, value);
  }
  return highest;
}

/**
 * A pool's state.
 *
 * A refusal we actually received outranks the percentage. Meta's figures lag —
 * they are a rolling aggregate computed on its side — so a pool can refuse a
 * call while still reporting under 100, and the refusal is the fact.
 */
function statusOf(
  usedPercent: number | null,
  /**
   * Refusals in the NEWEST minute, NOT the window total.
   *
   * Driving this from the window total meant one refusal at breakfast painted a
   * pool red — and escalated the whole enterprise heading and the banner —
   * until breakfast the next day, long after Meta had gone back to reporting
   * 3%. Guaranteed alarm fatigue on a screen whose only job is to be believed.
   *
   * The signal wanted here is "something is still hammering a pool that has
   * already said no", and "still" is the part the day-wide count cannot express.
   */
  latestThrottledCalls: number,
  regainMinutes: number | null,
): MetaPoolStatus {
  if (latestThrottledCalls > 0 || (regainMinutes !== null && regainMinutes > 0)) return 'throttled';
  if (usedPercent === null) return 'unknown';
  if (usedPercent >= META_USAGE_THROTTLE_PCT) return 'throttled';
  if (usedPercent >= META_USAGE_WARN_PCT) return 'warning';
  return 'ok';
}

const STATUS_ORDER: Record<MetaPoolStatus, number> = {
  throttled: 0,
  warning: 1,
  unknown: 2,
  ok: 3,
};

function worstStatus(pools: readonly MetaPoolView[]): MetaPoolStatus {
  return pools.reduce<MetaPoolStatus>(
    (worst, pool) => (STATUS_ORDER[pool.status] < STATUS_ORDER[worst] ? pool.status : worst),
    'ok',
  );
}

function byUsedPercentDescending(a: MetaPoolView, b: MetaPoolView): number {
  const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (byStatus !== 0) return byStatus;
  return (b.usedPercent ?? -1) - (a.usedPercent ?? -1);
}

/**
 * How many calls the allowance appears to be, from our count and Meta's
 * percentage.
 *
 * Meta publishes the formula and never the number, and the number is what an
 * operator wants. This is the only route to one: if our N calls moved the gauge
 * to P percent, the whole pool is about N × 100 / P.
 *
 * DELIBERATELY REFUSES more often than it answers. Below a few percent the
 * whole-number rounding makes the result meaningless, and a percentage recorded
 * without any calls of ours behind it means another process spent it — in which
 * case our count is not the numerator and the answer would be nonsense.
 */
function estimateAllowance(calls: number, callPct: number | null): number | null {
  if (callPct === null || callPct < MIN_PERCENT_FOR_ESTIMATE || calls <= 0) return null;
  return Math.round((calls * 100) / callPct);
}
