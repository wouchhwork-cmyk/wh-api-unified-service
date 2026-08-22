/**
 * Database CLI. Run with Node's own --env-file so there is exactly one way the
 * environment is populated:
 *
 *   node --env-file=.env.dev --import tsx scripts/db.ts migrate
 */
import { DataSource } from 'typeorm';
import AppDataSource, { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { applyPostTableObjects, applyPreTableObjects } from '../src/database/schema/schema-objects';

type Command = 'migrate' | 'revert' | 'drop' | 'status' | 'sync';

const COMMANDS: readonly Command[] = ['migrate', 'revert', 'drop', 'status', 'sync'];

/** Postgres says the object is already there. Under `sync` that is the goal. */
const ALREADY_EXISTS = new Set([
  '42710', // duplicate_object — constraint, trigger, extension
  '42P07', // duplicate_table — index
  '42P16', // invalid_table_definition, e.g. a primary key already present
]);

function parseCommand(raw: string | undefined): Command {
  if (raw && (COMMANDS as readonly string[]).includes(raw)) return raw as Command;
  throw new Error(`Usage: db.ts <${COMMANDS.join('|')}>`);
}

/**
 * Creates the database itself if it is not there yet.
 *
 * Nothing else can: `synchronize` and migrations both operate INSIDE a database,
 * and CREATE DATABASE requires a connection to a different one — so a missing
 * database surfaces as a raw driver error naming a file nobody has heard of.
 * Compose creates it from POSTGRES_DB, but only when the volume is brand new,
 * which is exactly the case that has already passed by the time somebody renames
 * a database or runs against a second one.
 *
 * Connects to `postgres`, the maintenance database every server has.
 */
async function ensureDatabaseExists(): Promise<void> {
  const database = loadConfiguration().database;
  const admin = new DataSource({
    ...buildDataSourceOptions(database),
    database: 'postgres',
    entities: [],
    migrations: [],
  });

  await admin.initialize();
  try {
    const existing: { count: string }[] = await admin.query(
      'SELECT count(*) AS count FROM pg_database WHERE datname = $1',
      [database.name],
    );
    if (existing[0]?.count === '0') {
      // The name comes from our own configuration, never from a request, and
      // CREATE DATABASE takes no parameters — so it has to be interpolated.
      // Quoted as an identifier to keep that honest.
      await admin.query(`CREATE DATABASE "${database.name.replace(/"/g, '""')}"`);
      console.log(`created database ${database.name}`);
    }
  } finally {
    await admin.destroy();
  }
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
async function stampMigrationsAsApplied(): Promise<void> {
  const table = AppDataSource.options.migrationsTableName ?? 'migrations';

  // Same shape TypeORM creates, so a later `db:migrate` on this database reads
  // and writes it without complaint.
  await AppDataSource.query(
    `CREATE TABLE IF NOT EXISTS "${table}" (
       "id"        SERIAL PRIMARY KEY,
       "timestamp" bigint NOT NULL,
       "name"      character varying NOT NULL
     )`,
  );

  let stamped = 0;
  for (const migration of AppDataSource.migrations) {
    const name = migration.name ?? migration.constructor.name;
    // TypeORM derives the ordering from the digits at the end of the class name.
    const timestamp = Number(/(\d+)$/.exec(name)?.[1] ?? 0);

    const inserted: unknown[] = await AppDataSource.query(
      `INSERT INTO "${table}" ("timestamp", "name")
       SELECT $1::bigint, $2::varchar
        WHERE NOT EXISTS (SELECT 1 FROM "${table}" WHERE "name" = $2::varchar)
       RETURNING "id"`,
      [timestamp, name],
    );
    if (inserted.length > 0) stamped += 1;
  }

  console.log(
    stamped === 0
      ? 'migration ledger already up to date'
      : `recorded ${stamped} migration(s) as applied, so readiness passes`,
  );
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);

  if (
    command === 'drop' &&
    (process.env.NODE_ENV === 'prod' || process.env.NODE_ENV === 'production')
  ) {
    throw new Error('refused: db drop is never allowed with NODE_ENV=prod');
  }

  /*
   * `sync` is a DEVELOPMENT TOOL AND NOTHING ELSE.
   *
   * TypeORM's synchroniser decides what to do by diffing entities against the
   * live database, so the same code produces different SQL against different
   * databases — and against a populated one it will happily ALTER or DROP a
   * column to make the shapes agree. That is the right trade while a schema is
   * moving daily and wrong the moment there is data somebody cares about.
   */
  if (command === 'sync' && process.env.NODE_ENV !== 'dev') {
    throw new Error(
      `refused: db sync is dev-only (NODE_ENV=${process.env.NODE_ENV ?? 'unset'}). ` +
        'qa and prod go through migrations.',
    );
  }

  // Before the app's own connection: initialize() would fail on a database that
  // does not exist yet, and `sync` is the command somebody runs from nothing.
  if (command === 'sync') await ensureDatabaseExists();

  await AppDataSource.initialize();
  try {
    switch (command) {
      case 'migrate': {
        const applied = await AppDataSource.runMigrations({ transaction: 'all' });
        if (applied.length === 0) {
          console.log('no pending migrations');
        } else {
          for (const migration of applied) console.log(`applied ${migration.name}`);
        }
        break;
      }
      case 'revert': {
        await AppDataSource.undoLastMigration({ transaction: 'all' });
        console.log('reverted the last migration');
        break;
      }
      case 'drop': {
        await AppDataSource.dropDatabase();
        console.log('dropped every table');
        break;
      }
      case 'sync': {
        /*
         * Two phases, and the second is the whole point.
         *
         * TypeORM creates and alters the TABLES to match the entities, which is
         * all it can do: entity metadata cannot express a partial unique index,
         * an expression index, a composite foreign key, a CHECK, gin_trgm_ops or
         * a REVOKE. Left there, synchronize would produce a database that boots
         * and has lost every guarantee in the schema — including the composite
         * foreign keys that make a cross-tenant row impossible.
         *
         * So phase two re-applies all 88 of those objects from the same module
         * the migration uses, tolerating the ones already present.
         */
        await applyPreTableObjects((sql) => AppDataSource.query(sql));
        console.log('extensions and the trigger function are in place');

        await AppDataSource.synchronize();
        console.log('tables now match the entities');

        let applied = 0;
        let existing = 0;
        await applyPostTableObjects(async (sql) => {
          try {
            const result = await AppDataSource.query(sql);
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
        console.log(
          `indexes, foreign keys, checks, triggers and grants: ${applied} applied, ${existing} already present`,
        );

        await stampMigrationsAsApplied();
        break;
      }
      case 'status': {
        const pending = await AppDataSource.showMigrations();
        console.log(pending ? 'migrations are PENDING' : 'schema is up to date');
        break;
      }
    }
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
