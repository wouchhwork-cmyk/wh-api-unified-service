import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import { MetaUsageCollector } from '@/modules/connections/graph/meta-usage.collector';
import { MetaApiUsageRepository } from '@/database/repositories/meta-api-usage.repository';
import type { MetaUsageBucket } from '@/database/repositories/meta-api-usage.repository';
import { Platform } from '@/shared/enums';

/**
 * The rate-limit monitor must actually be wired in, in BOTH processes.
 *
 * `GraphApiClient` takes its collector as an OPTIONAL dependency so that a
 * dozen unit tests can construct a client from configuration alone. The price
 * is that a missing provider does not fail at boot — it fails by silently
 * recording nothing, and a dashboard reading zero looks exactly like one
 * reading nothing.
 *
 * THIS FILE USED TO BE A GREP over the module source, and that was worth very
 * little: the regex matched `MetaUsageCollector` anywhere after the first
 * `providers:` in the file — a comment, an `exports:` array, an import line
 * below — so it never proved membership of the provider list at all.
 *
 * Two assertions replace it. The first reads Nest's OWN metadata, which is the
 * declaration the injector uses rather than the text a human wrote. The second
 * proves the behaviour end to end: a client holding a collector records a
 * reading from a real response.
 *
 * IT LIVES WITH THE INTEGRATION TESTS DESPITE TOUCHING NO DATABASE. Importing
 * either module reaches `data-source.ts`, which loads configuration at module
 * scope — so it needs the environment that only this project's setup provides.
 * `fetch` is stubbed; nothing here opens a connection.
 */
describe('the Meta rate-limit collector is wired in', () => {
  /** What Nest will actually inject, as the decorator recorded it. */
  const providersOf = (module: object): unknown[] =>
    (Reflect.getMetadata('providers', module) as unknown[]) ?? [];

  /*
   * Imported DYNAMICALLY so that a failure to load one module reports as a
   * failing assertion rather than as a file that never ran.
   */
  const modules = async (): Promise<{
    connections: object;
    workers: object;
    database: object;
  }> => {
    const [connections, workers, database] = await Promise.all([
      import('@/modules/connections/connections.module'),
      import('@/workers/workers.module'),
      import('@/database/database.module'),
    ]);
    return {
      connections: connections.ConnectionsModule,
      workers: workers.WorkersModule,
      database: database.DatabaseModule,
    };
  };

  describe('the declaration Nest reads', () => {
    it('provides the collector to the API process', async () => {
      const { connections } = await modules();
      expect(providersOf(connections)).toContain(MetaUsageCollector);
    });

    it('provides the collector to the WORKER process', async () => {
      /*
       * The workers matter more than the API here: backfills, relays and
       * refreshes make the overwhelming majority of Graph calls, so a monitor
       * wired only into the API would report a fraction of the platform's
       * traffic and present it as the whole.
       */
      const { workers } = await modules();
      expect(providersOf(workers)).toContain(MetaUsageCollector);
    });

    it('provides the Graph client alongside it, so the check means something', async () => {
      // Without this the assertions above could pass against a module that no
      // longer builds a Graph client at all.
      const { connections, workers } = await modules();
      expect(providersOf(connections)).toContain(GraphApiClient);
      expect(providersOf(workers)).toContain(GraphApiClient);
    });

    it('keeps the repository in the global database module', async () => {
      /*
       * Both the collector and the platform console need it. Providing it twice
       * would give them separate instances against the same table — harmless
       * today, and exactly the kind of thing that stops being harmless when one
       * of them gains a cache.
       */
      const { database } = await modules();
      expect(providersOf(database)).toContain(MetaApiUsageRepository);
    });
  });

  describe('what a wired client actually does', () => {
    const originalFetch = globalThis.fetch;
    let written: MetaUsageBucket[];
    let collector: MetaUsageCollector;

    const repository = {
      record: async (buckets: readonly MetaUsageBucket[]): Promise<number> => {
        written.push(...buckets);
        return buckets.length;
      },
      resolveOwners: async () => [],
    } as unknown as MetaApiUsageRepository;

    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    const config = {
      meta: { graphApiVersion: 'v25.0', appId: 'app', appSecret: 'secret' },
    } as never;

    beforeEach(() => {
      written = [];
      collector = new MetaUsageCollector(repository, logger as never);
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('records the usage header from a real response shape', async () => {
      /*
       * The end-to-end proof the grep could never give. The header is the exact
       * one the live API returned on 21 Sep 2026 for a Page node read.
       */
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ id: 'PAGE_1', name: 'Blue Bottle' }), {
          status: 200,
          headers: {
            'x-business-use-case-usage':
              '{"651551841371924":[{"type":"pages","call_count":7,"total_cputime":1,' +
              '"total_time":1,"estimated_time_to_regain_access":0}]}',
          },
        })) as typeof globalThis.fetch;

      const client = new GraphApiClient(config, collector);
      await client.getChannelProfile('651551841371924', 'token', Platform.Facebook);
      await collector.flush();

      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        scopeKey: '651551841371924:pages',
        product: 'pages',
        callPct: 7,
        calls: 1,
      });
    });

    it('records a call even when Meta sends no usage header', async () => {
      // Under its own scope, never the app pool — a Page-token call touches no
      // app allowance, and claiming it there blanks a gauge that reads fine.
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ id: 'PAGE_1', name: 'Blue Bottle' }), {
          status: 200,
        })) as typeof globalThis.fetch;

      const client = new GraphApiClient(config, collector);
      await client.getChannelProfile('651551841371924', 'token', Platform.Facebook);
      await collector.flush();

      expect(written.map((bucket) => bucket.scopeKey)).toEqual(['unknown']);
      expect(written[0]?.callPct).toBeNull();
    });

    it('does NOT break the call when no collector is wired at all', async () => {
      /*
       * The reason the dependency is optional, pinned: a client built without
       * one still works. This is what the unit tests elsewhere rely on, and it
       * is also what makes a missing provider silent — hence the metadata
       * assertions above.
       */
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ id: 'PAGE_1', name: 'Blue Bottle' }), {
          status: 200,
        })) as typeof globalThis.fetch;

      const client = new GraphApiClient(config);

      /*
       * `name`, not `id`: the response is validated against
       * GraphChannelProfileSchema, which declares the fields this call asks
       * for and strips the rest. Asserting a stripped field would have made
       * this test fail for a reason that has nothing to do with wiring.
       */
      await expect(
        client.getChannelProfile('651551841371924', 'token', Platform.Facebook),
      ).resolves.toMatchObject({ name: 'Blue Bottle' });
    });
  });
});
