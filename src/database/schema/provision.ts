import { DataSource } from 'typeorm';
import type { DatabaseConfig } from '@/config/config.types';
import { buildDataSourceOptions } from '@/database/data-source';
import { applyPostTableObjects, applyPreTableObjects } from './schema-objects';

/** Postgres says the object is already there. Under a sync that is the goal. */
const ALREADY_EXISTS = new Set([
  '42710', // duplicate_object — constraint, trigger, extension
  '42P07', // duplicate_table — index
  '42P16', // invalid_table_definition, e.g. a primary key already present
]);

export interface SyncReport {
  readonly applied: number;
  readonly existing: number;
  readonly stamped: number;
}

/**
 * Creates the database itself if it is not there yet.
 *
 * Nothing else can: `synchronize` and migrations both operate INSIDE a database,
 * and CREATE DATABASE requires a connection to a different one — so a missing
 * database surfaces as a raw driver error naming a file nobody has heard of.
 * Compose creates it from POSTGRES_DB, but only when the volume is brand new,
 * which is exactly the case that has already passed by the time somebody renames
 * a database or runs against a second one — the test database, for instance.
 *
 * Connects to `postgres`, the maintenance database every server has.
 */
export async function ensureDatabaseExists(database: DatabaseConfig): Promise<boolean> {
  const admin = new DataSource({
    ...buildDataSourceOptions(database),
    database: 'postgres',
    entities: [],
    migrations: [],
  });

  await admin.initialize();
  try {
    /*
     * EXISTENCE IS ASKED AS A BOOLEAN, not counted and string-compared.
     *
     * This read `count(*)` and compared the result against the STRING '0' —
     * which is what node-postgres returns for a bigint by default, and is not
     * what it returns here: pg-types.ts registers a global int8 parser that
     * coerces bigints to numbers. So the comparison was `0 !== '0'`, always
     * true, and this function never once created a database. It looked like it
     * worked only because every database it was ever pointed at already existed;
     * the day a new suite needed one, every test in it failed on "database does
     * not exist" two processes away from the cause.
     */
    const existing = await admin.query<{ present: boolean }[]>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present',
      [database.name],
    );
    if (existing[0]?.present === true) return false;

    // The name comes from our own configuration, never from a request, and
    // CREATE DATABASE takes no parameters — so it has to be interpolated.
    // Quoted as an identifier to keep that honest.
    await admin.query(`CREATE DATABASE "${database.name.replace(/"/g, '""')}"`);
    return true;
  } finally {
    await admin.destroy();
  }
}

/**
 * Brings a database up to the entities, in two phases — and the second is the
 * whole point.
 *
 * TypeORM creates and alters the TABLES to match the entities, which is all it
 * can do: entity metadata cannot express a partial unique index, an expression
 * index, a composite foreign key, a CHECK, gin_trgm_ops or a REVOKE. Left there,
 * synchronize would produce a database that boots and has lost every guarantee
 * in the schema — including the composite foreign keys that make a cross-tenant
 * row impossible.
 *
 * So phase two re-applies all of those objects from the same module the
 * migration uses, tolerating the ones already present.
 *
 * Lives here rather than in scripts/db.ts because the TEST harness needs the
 * same path: without it a fresh clone could not run the integration or e2e
 * suites at all, since nothing created the test database or gave it a schema.
 * scripts/ is also excluded from the compiled build, so a copy there is a copy
 * nothing else can reach.
 */
export async function syncSchema(dataSource: DataSource): Promise<SyncReport> {
  await applyPreTableObjects((sql) => dataSource.query(sql));
  await dataSource.synchronize();

  let applied = 0;
  let existing = 0;
  await applyPostTableObjects(async (sql) => {
    try {
      const result = await dataSource.query(sql);
      applied += 1;
      return result;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code && ALREADY_EXISTS.has(code)) {
        existing += 1;
        return undefined;
      }
      throw error;
    }
  });

  const stamped = await stampMigrationsAsApplied(dataSource);
  return { applied, existing, stamped };
}

/**
 * Records the migrations as applied, without running them.
 *
 * A sync-built database has no migration ledger, so TypeORM reports one pending
 * forever — and readiness checks exactly that. Left alone, every sync-built
 * instance answers 503 on /health/ready and an orchestrator never sends it
 * traffic: a development convenience quietly breaking a production probe.
 *
 * Claiming "applied" is honest here rather than a fiction. Both paths run the
 * same schema-objects module over the same entities, and
 * test/integration/schema-parity.spec.ts asserts the two produce the same
 * indexes, keys, checks, triggers and columns. The schema really is at that
 * revision; it simply arrived by the other road.
 */
async function stampMigrationsAsApplied(dataSource: DataSource): Promise<number> {
  const table = dataSource.options.migrationsTableName ?? 'migrations';

  // Same shape TypeORM creates, so a later migrate on this database reads and
  // writes it without complaint.
  await dataSource.query(
    `CREATE TABLE IF NOT EXISTS "${table}" (
       "id"        SERIAL PRIMARY KEY,
       "timestamp" bigint NOT NULL,
       "name"      character varying NOT NULL
     )`,
  );

  let stamped = 0;
  for (const migration of dataSource.migrations) {
    const name = migration.name ?? migration.constructor.name;
    // TypeORM derives the ordering from the digits at the end of the class name.
    const timestamp = Number(/(\d+)$/.exec(name)?.[1] ?? 0);

    const inserted: unknown[] = await dataSource.query(
      `INSERT INTO "${table}" ("timestamp", "name")
       SELECT $1::bigint, $2::varchar
        WHERE NOT EXISTS (SELECT 1 FROM "${table}" WHERE "name" = $2::varchar)
       RETURNING "id"`,
      [timestamp, name],
    );
    if (inserted.length > 0) stamped += 1;
  }
  return stamped;
}
