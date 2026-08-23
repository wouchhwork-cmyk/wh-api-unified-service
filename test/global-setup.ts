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

/**
 * Creates the test database and brings its schema up to date, ONCE, before any
 * suite runs.
 *
 * Without this, `pnpm test:all` on a fresh clone failed on a database that
 * nothing had created — the harnesses connect straight to `<name>_test`, and the
 * only code that could create or shape it lived in scripts/db.ts, pointed at the
 * DEVELOPMENT database. So running the tests was an undocumented two-step that
 * every new machine, and every CI runner, had to be told about out of band.
 *
 * It goes through the same provisioning module `pnpm db:sync` uses, so the schema
 * the tests run against is built the same way a developer's is — including the
 * partial indexes, composite foreign keys and CHECKs that TypeORM's synchroniser
 * cannot express and that most of the interesting assertions depend on.
 */
export default async function setup(): Promise<void> {
  const { database } = loadConfiguration();
  if (await ensureDatabaseExists(database)) {
    console.log(`created test database ${database.name}`);
  }

  const dataSource = new DataSource(buildDataSourceOptions(database));
  await dataSource.initialize();
  try {
    const report = await syncSchema(dataSource);
    console.log(
      `test schema ready on ${database.name} ` +
        `(${report.applied} objects applied, ${report.existing} already present)`,
    );
  } finally {
    await dataSource.destroy();
  }
}
