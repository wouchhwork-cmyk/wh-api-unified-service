/*
 * FIRST IMPORT, AND IT HAS TO BE.
 *
 * ES modules evaluate their imports in declaration order, and
 * @/database/data-source builds a DataSource from loadConfiguration() at module
 * scope. Import anything from src/ ahead of this and the config is validated
 * against an empty environment, which fails with "Invalid environment
 * configuration" before a single line of this file runs.
 */
import './env-setup';

import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '@/database/data-source';
import { loadConfiguration } from '@/config/configuration';
import { ensureDatabaseExists, syncSchema } from '@/database/schema/provision';

/** The suites that own a database, and the suffix each one gets. */
const SUITE_SUFFIXES = ['_test', '_e2e'] as const;

/**
 * Creates every suite's database and brings its schema up to date, ONCE, before
 * anything runs.
 *
 * Without this, `pnpm test:all` on a fresh clone failed on a database that
 * nothing had created — the harnesses connect straight to their database, and
 * the only code that could create or shape one lived in scripts/db.ts pointed at
 * the DEVELOPMENT database. Running the tests was an undocumented two-step that
 * every new machine, and every CI runner, had to be told about out of band.
 *
 * It goes through the same provisioning module `pnpm db:sync` uses, so the schema
 * the tests run against is built the same way a developer's is — including the
 * partial indexes, composite foreign keys and CHECKs that TypeORM's synchroniser
 * cannot express and that most of the interesting assertions depend on.
 *
 * BOTH databases are provisioned HERE, at the root, rather than one per project.
 * A project-scoped globalSetup does not run early enough: the harness opened its
 * connection first and failed on a database that had not been created yet. So
 * this pays one connection on behalf of the unit suite, which needs none, in
 * exchange for a suite that works from a clean checkout.
 */
export default async function setup(): Promise<void> {
  /*
   * The name is OVERRIDDEN per suite rather than re-resolved through the
   * environment. Calling loadTestEnv again per suffix would re-read and
   * re-validate the whole environment inside a loop for one string, and the
   * failure mode of getting that wrong is invisible: the second suite silently
   * provisions the first suite's database and the run fails much later, on a
   * database nobody created.
   */
  const { database } = loadConfiguration();
  const base = database.name.replace(/_(dev|test|e2e)$/, '');

  for (const suffix of SUITE_SUFFIXES) {
    const target = { ...database, name: `${base}${suffix}` };

    /*
     * LOUD ON FAILURE. Vitest does not always surface a rejected globalSetup
     * before it starts the run, so a provisioning error used to present as every
     * test in one suite failing on "database does not exist" — the symptom, not
     * the cause, and in a different process from the one that could explain it.
     */
    try {
      if (await ensureDatabaseExists(target)) {
        console.log(`created test database ${target.name}`);
      }

      // Created and destroyed inside this iteration, so the two never coexist.
      const dataSource = new DataSource(buildDataSourceOptions(target));
      await dataSource.initialize();
      try {
        const report = await syncSchema(dataSource, { appRole: target.appRole });
        console.log(
          `test schema ready on ${target.name} ` +
            `(${report.applied} objects applied, ${report.existing} already present)`,
        );
      } finally {
        await dataSource.destroy();
      }
    } catch (error) {
      console.error(
        `FAILED to provision ${target.name}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      throw error;
    }
  }
}
