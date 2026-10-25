import { describe, expect, it } from 'vitest';
import { RateLimitService } from '@/modules/platform/rate-limit.service';
import { MAX_MONITORED_POOLS } from '@/shared/constants';
import { MetaUsageMeter, Provider } from '@/shared/enums';
import type {
  ProviderApiUsageRepository,
  ProviderUsageCurrentRow,
} from '@/database/repositories/provider-api-usage.repository';

/**
 * The console says when it is not showing everything.
 *
 * A CONTROL WITH A THRESHOLD NEEDS A TEST PROVING IT CAN FAIL, and this one
 * had none. The listing is ordered by usage, so the pools that fall off the
 * end are the QUIET ones — and on a console a quiet pool and a missing pool
 * look identical. Somebody checking whether a tenant is being throttled would
 * read "not listed" as "fine", which is the exact misreading `truncated`
 * exists to prevent.
 *
 * No database: `truncated` is arithmetic on the row count, so a stub
 * repository is the honest way to drive it to the boundary and one past it.
 */
describe('the monitored-pool cap', () => {
  const row = (n: number): ProviderUsageCurrentRow =>
    ({
      provider: Provider.Meta,
      scopeKey: `pool-${n}`,
      meter: MetaUsageMeter.BusinessUseCase,
      product: null,
      providerScopeId: null,
      enterpriseId: null,
      enterpriseName: null,
      enterpriseRefId: null,
      channelId: null,
      channelName: null,
      channelPlatform: null,
      platformChannelId: null,
      callPct: 1,
      cpuPct: null,
      timePct: null,
      regainMinutes: null,
      lastSeenAt: new Date(),
      hourCalls: 0,
      hourThrottledCalls: 0,
      hourFailedCalls: 0,
      dayCalls: 0,
      dayThrottledCalls: 0,
      dayFailedCalls: 0,
      latestThrottledCalls: 0,
      recentThrottledCalls: 0,
    }) as ProviderUsageCurrentRow;

  const serviceReturning = (count: number): RateLimitService =>
    new RateLimitService({
      current: async () => Array.from({ length: count }, (_, i) => row(i)),
    } as unknown as ProviderApiUsageRepository);

  it('does not claim truncation while it is under the cap', async () => {
    const overview = await serviceReturning(MAX_MONITORED_POOLS - 1).overview();
    expect(overview.truncated).toBe(false);
  });

  /** The assertion that matters: a full page says so. */
  it('reports truncation once the listing fills the cap', async () => {
    const overview = await serviceReturning(MAX_MONITORED_POOLS).overview();
    expect(overview.truncated).toBe(true);
  });

  it('asks the repository for exactly the cap, never an unbounded list', async () => {
    let asked: number | null = null;
    const service = new RateLimitService({
      current: async (limit: number) => {
        asked = limit;
        return [];
      },
    } as unknown as ProviderApiUsageRepository);

    await service.overview();
    expect(asked).toBe(MAX_MONITORED_POOLS);
  });
});
