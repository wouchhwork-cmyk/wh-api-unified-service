import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '@/database/data-source';
import { loadConfiguration } from '@/config/configuration';
import { applyPostTableObjects, applyPreTableObjects } from '@/database/schema/schema-objects';

/**
 * The migration and `pnpm db:sync` must produce the SAME schema.
 *
 * Two ways into a database is two ways to be wrong, and the failure is silent:
 * synchronize cannot express a partial unique index or a composite foreign key,
 * so a sync-built database can look perfectly healthy while a business's
 * conversation is free to point at another business's channel.
 *
 * The migrated side replays the FULL migration list, so a table or column a
 * later migration adds is compared too — not only the initial schema.
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

/*
 * RUN ON DEMAND, NOT ON EVERY CHANGE: `pnpm test:schema`.
 *
 * It compares a database built by the MIGRATION against one built by the
 * ENTITIES. While a schema is moving daily those two are meant to disagree — you
 * change an entity, run db:sync, and the migration is deliberately left behind
 * until it is worth writing. Gating every test run on that would make a red
 * suite the normal state, which is how a red suite stops meaning anything.
 *
 * So it is a PRE-DEPLOY gate. It must pass before anything ships to qa or prod,
 * because that is the moment the migration becomes the authority again.
 */
/**
 * Two renderings of the same index predicate, made comparable.
 *
 * `ALTER TABLE ... ALTER COLUMN ... TYPE` REBUILDS every index that depends on
 * the column, and Postgres re-renders the rebuilt predicate in a different but
 * equivalent form. Migration 1757700000000 retypes 121 timestamp columns, so
 * every index whose predicate mentions one comes out of the migrated database
 * spelled differently from the synced one:
 *
 *   migrated  status::text = ANY (ARRAY[('pending'::character varying)::text, ...])
 *   synced    status::text = ANY ((ARRAY['pending'::character varying, ...])::text[])
 *
 * Same columns, same predicate, same plan — only the parenthesisation of the
 * casts differs. Comparing the raw text would fail forever on a difference that
 * is not one, so the casts and grouping parentheses are stripped before
 * comparing.
 *
 * SAFE TO STRIP, because column types are asserted separately and exactly, by
 * the `columns` comparison. Nothing that distinguishes two real indexes —
 * table, name, columns, order, WHERE clause, uniqueness — is touched here.
 */
function comparableIndexes(values: string[]): string[] {
  return values
    .map((value) =>
      value
        .replace(/::(?:character varying|text|bpchar)(?:\[\])?/g, '')
        .replace(/[()]/g, ' ')
        .replace(/\s+/g, ' ')
        // Dropping the parentheses leaves the two forms spaced differently
        // inside the ARRAY literal, so separators are closed up too.
        .replace(/\s*([[\],])\s*/g, '$1')
        .trim(),
    )
    .sort();
}

describe.skipIf(!process.env.SCHEMA_PARITY)('the migration and db:sync agree', () => {
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
    const base = buildDataSourceOptions(loadConfiguration().database);
    /*
     * EVERY migration, in the order `data-source.ts` lists them — not just the
     * initial one.
     *
     * Replaying only the first migration compared a database from ONE migration
     * against a database from ALL the entities, so anything a later migration
     * created was guaranteed to look like drift. That stayed invisible for as
     * long as the later migrations only added indexes, because indexes come
     * from `schema-objects`, which both paths share. The first later migration
     * to create a TABLE — `1758100000000-MetaApiUsage` — is what exposed it.
     *
     * Taking the list from the same factory the application uses also means a
     * migration nobody registered fails here, which is the mistake
     * `data-source.ts` warns about in its own comment.
     */
    const dataSource = new DataSource({
      ...base,
      database,
      // `?? []` because the options type allows `migrations` to be absent, and
      // under exactOptionalPropertyTypes an `undefined` here is not the same as
      // an omitted key.
      migrations: withMigrations ? (base.migrations ?? []) : [],
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
      expect(comparableIndexes(withoutLedger(fromSync.indexes))).toEqual(
        comparableIndexes(withoutLedger(fromMigration.indexes)),
      );
      expect(fromSync.foreignKeys).toEqual(fromMigration.foreignKeys);
      expect(fromSync.checks).toEqual(fromMigration.checks);
      expect(fromSync.triggers).toEqual(fromMigration.triggers);

      // A guard against the comparison passing because both sides are empty.
      expect(fromMigration.foreignKeys.length).toBeGreaterThan(60);
      expect(fromMigration.indexes.length).toBeGreaterThan(80);
      // Two from the initial schema, four guarding the rate-limit monitor's
      // percentages and counts, and one keeping a role's level in range.
      expect(fromMigration.checks).toHaveLength(7);
    } finally {
      await synced.destroy();
      await migrated.destroy();
    }
  }, 180_000);
});
