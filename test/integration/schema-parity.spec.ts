import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '@/database/data-source';
import { loadConfiguration } from '@/config/configuration';
import { InitialSchema1756000000000 } from '@/database/migrations/1756000000000-InitialSchema';
import { applyPostTableObjects, applyPreTableObjects } from '@/database/schema/schema-objects';

/**
 * The migration and `pnpm db:sync` must produce the SAME schema.
 *
 * Two ways into a database is two ways to be wrong, and the failure is silent:
 * synchronize cannot express a partial unique index or a composite foreign key,
 * so a sync-built database can look perfectly healthy while a business's
 * conversation is free to point at another business's channel.
 *
 * Both paths share one module, which makes drift unlikely rather than
 * impossible — TypeORM could change a column type such that an index no longer
 * applies, and nothing else would notice. So this builds a database each way and
 * compares what Postgres actually ended up with.
 *
 * Primary key NAMES are excluded and nothing else is: the migration declares
 * PRIMARY KEY inline and gets `<table>_pkey`, while synchronize emits
 * `PK_<hash>`. Same columns, same uniqueness, different label.
 */
const MIGRATED = 'wouchh_parity_migrated';
const SYNCED = 'wouchh_parity_synced';

interface SchemaFacts {
  indexes: string[];
  foreignKeys: string[];
  checks: string[];
  notNulls: string[];
  triggers: string[];
  columns: string[];
}

describe('the migration and db:sync agree', () => {
  let admin: DataSource;

  beforeAll(async () => {
    admin = new DataSource({
      ...buildDataSourceOptions(loadConfiguration().database),
      database: 'postgres',
      entities: [],
      migrations: [],
    });
    await admin.initialize();

    for (const name of [MIGRATED, SYNCED]) {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.query(`CREATE DATABASE ${name}`);
    }
  }, 180_000);

  afterAll(async () => {
    if (!admin?.isInitialized) return;
    for (const name of [MIGRATED, SYNCED]) {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    }
    await admin.destroy();
  }, 180_000);

  async function connect(database: string, withMigrations: boolean): Promise<DataSource> {
    const dataSource = new DataSource({
      ...buildDataSourceOptions(loadConfiguration().database),
      database,
      migrations: withMigrations ? [InitialSchema1756000000000] : [],
    });
    await dataSource.initialize();
    return dataSource;
  }

  async function factsOf(dataSource: DataSource): Promise<SchemaFacts> {
    const rows = async (sql: string): Promise<string[]> => {
      const result: { value: string }[] = await dataSource.query(sql);
      return result.map((row) => row.value).sort();
    };

    return {
      // The definition, not just the name: a partial index that lost its WHERE
      // clause would keep its name and stop being the constraint we rely on.
      indexes: await rows(`
        SELECT indexdef AS value FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname NOT LIKE 'PK_%'
           AND indexname NOT LIKE '%_pkey'`),
      foreignKeys: await rows(`
        SELECT pg_get_constraintdef(c.oid) AS value FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND c.contype = 'f'`),
      checks: await rows(`
        SELECT pg_get_constraintdef(c.oid) AS value FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND c.contype = 'c'`),
      notNulls: await rows(`
        SELECT table_name || '.' || column_name AS value
          FROM information_schema.columns
         WHERE table_schema = 'public' AND is_nullable = 'NO'`),
      triggers: await rows(`
        SELECT tgname AS value FROM pg_trigger WHERE NOT tgisinternal`),
      columns: await rows(`
        SELECT table_name || '.' || column_name || ':' || data_type AS value
          FROM information_schema.columns
         WHERE table_schema = 'public'`),
    };
  }

  it('produces the same indexes, keys, checks, triggers and columns', async () => {
    const migrated = await connect(MIGRATED, true);
    const synced = await connect(SYNCED, false);

    try {
      await migrated.runMigrations({ transaction: 'all' });

      await applyPreTableObjects((sql) => synced.query(sql));
      await synced.synchronize();
      await applyPostTableObjects((sql) => synced.query(sql));

      const fromMigration = await factsOf(migrated);
      const fromSync = await factsOf(synced);

      // schema_migrations exists only where a migration ran, so it is not part
      // of the comparison.
      const withoutLedger = (values: string[]): string[] =>
        values.filter((value) => !value.includes('schema_migrations'));

      expect(withoutLedger(fromSync.columns)).toEqual(withoutLedger(fromMigration.columns));
      expect(withoutLedger(fromSync.notNulls)).toEqual(withoutLedger(fromMigration.notNulls));
      expect(withoutLedger(fromSync.indexes)).toEqual(withoutLedger(fromMigration.indexes));
      expect(fromSync.foreignKeys).toEqual(fromMigration.foreignKeys);
      expect(fromSync.checks).toEqual(fromMigration.checks);
      expect(fromSync.triggers).toEqual(fromMigration.triggers);

      // A guard against the comparison passing because both sides are empty.
      expect(fromMigration.foreignKeys.length).toBeGreaterThan(60);
      expect(fromMigration.indexes.length).toBeGreaterThan(80);
      expect(fromMigration.checks).toHaveLength(2);
    } finally {
      await synced.destroy();
      await migrated.destroy();
    }
  }, 180_000);
});
