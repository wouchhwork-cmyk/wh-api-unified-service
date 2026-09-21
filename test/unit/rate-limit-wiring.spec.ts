import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The rate-limit monitor must actually be wired in, in BOTH processes.
 *
 * `GraphApiClient` takes its collector as an OPTIONAL dependency, so that a
 * dozen unit tests can construct a client from configuration alone. The price
 * of that convenience is that a missing provider does not fail at boot — it
 * fails by silently recording nothing, which is the one failure this feature
 * cannot tolerate: a dashboard reading zero and a dashboard reading nothing
 * look identical, and the second one is a lie.
 *
 * The workers matter more than the API here. Backfills, relays and refreshes
 * make the overwhelming majority of Graph calls, so a monitor wired only into
 * the API would report a fraction of the platform's traffic and present it as
 * the whole.
 *
 * Asserted over the source for the reason `controller-layering.spec.ts` is: the
 * mistake is one of intent, and the provider list is where the intent is
 * written.
 */
const WIRINGS = [
  {
    what: 'the API process',
    file: join(process.cwd(), 'src', 'modules', 'connections', 'connections.module.ts'),
  },
  {
    what: 'the worker process',
    file: join(process.cwd(), 'src', 'workers', 'workers.module.ts'),
  },
];

describe('the Meta rate-limit collector is wired in', () => {
  for (const wiring of WIRINGS) {
    it(`is provided to ${wiring.what}`, () => {
      const source = readFileSync(wiring.file, 'utf8');

      expect(source).toContain('MetaUsageCollector');
      // Imported AND listed: an import alone leaves the client without one.
      expect(source).toMatch(/providers:[\s\S]*MetaUsageCollector/);
    });

    it(`still provides GraphApiClient in ${wiring.what}, so the check means something`, () => {
      // If the client ever moved, the assertion above would pass against a file
      // that no longer builds a Graph client at all.
      expect(readFileSync(wiring.file, 'utf8')).toContain('GraphApiClient');
    });
  }

  it('keeps the repository in the global database module', () => {
    /*
     * Both the collector and the platform console need it. Providing it twice
     * would give them separate instances against the same table — harmless
     * today, and exactly the kind of thing that stops being harmless when one
     * of them gains a cache.
     */
    const source = readFileSync(
      join(process.cwd(), 'src', 'database', 'database.module.ts'),
      'utf8',
    );

    expect(source).toContain('MetaApiUsageRepository');
  });
});
