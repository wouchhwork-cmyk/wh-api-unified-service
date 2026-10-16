/**
 * Database CLI. Run with Node's own --env-file so there is exactly one way the
 * environment is populated:
 *
 *   node --env-file=.env.dev --import tsx scripts/db.ts migrate
 *
 * This is a DEVELOPMENT tool. The production path is `node dist/migrate.js`,
 * which is compiled into the runtime image and can only apply or report — see
 * src/migrate.ts for why the destructive commands are deliberately absent there.
 */
import AppDataSource from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { ensureDatabaseExists, syncSchema } from '../src/database/schema/provision';

type Command = 'migrate' | 'revert' | 'drop' | 'status' | 'sync';

const COMMANDS: readonly Command[] = ['migrate', 'revert', 'drop', 'status', 'sync'];

/** Commands that destroy data, and therefore need more than a typo to run. */
const DESTRUCTIVE: ReadonlySet<Command> = new Set<Command>(['drop', 'revert']);

/** Hosts a destructive command may point at. Compose service names included. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  'postgres',
  'db',
]);

function parseCommand(raw: string | undefined): Command {
  if (raw && (COMMANDS as readonly string[]).includes(raw)) return raw as Command;
  throw new Error(`Usage: db.ts <${COMMANDS.join('|')}>`);
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const { database } = loadConfiguration();

  /*
   * SAY WHERE, EVERY TIME.
   *
   * These scripts pass `--env-file=.env.dev`, and Node lets a REAL environment
   * variable win over the file — so a shell with DB_HOST exported points every
   * one of them somewhere else while the command line still reads ".env.dev".
   * Printing the resolved target is the cheapest way for that to be noticed
   * before rather than after.
   */
  console.log(`target: ${database.user}@${database.host}:${database.port}/${database.name}`);

  if (DESTRUCTIVE.has(command)) {
    /*
     * THE TARGET, NOT THE LABEL.
     *
     * NODE_ENV comes from the same --env-file that an exported DB_HOST beats, so
     * checking it alone is checking the one value the failure mode does not
     * change. The host and the database name are what decide what gets
     * destroyed.
     */
    if (process.env.NODE_ENV !== 'dev') {
      throw new Error(
        `refused: db ${command} is dev-only (NODE_ENV=${process.env.NODE_ENV ?? 'unset'}).`,
      );
    }
    if (!LOCAL_HOSTS.has(database.host.toLowerCase())) {
      throw new Error(
        `refused: db ${command} against host "${database.host}", which is not local. ` +
          'An exported DB_HOST beats --env-file — check your shell.',
      );
    }
    if (!/_(dev|test|local)$/.test(database.name)) {
      throw new Error(
        `refused: db ${command} against "${database.name}", which does not end in ` +
          '_dev, _test or _local, so it is not a disposable database.',
      );
    }
    /*
     * And name the database you mean.
     *
     * `revert` had no guard at all, and the only migration's down() drops every
     * table — so one mistyped command against a populated database was total,
     * unconfirmable data loss. Requiring the name to be typed makes the blast
     * radius something the operator has to have looked at.
     */
    if (process.env.DB_CONFIRM !== database.name) {
      throw new Error(
        `refused: db ${command} destroys data. Re-run with DB_CONFIRM=${database.name} ` +
          'to confirm that is the database you mean.',
      );
    }
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
  if (command === 'sync' && (await ensureDatabaseExists(database))) {
    console.log(`created database ${database.name}`);
  }

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
        const report = await syncSchema(AppDataSource, { appRole: database.appRole });
        console.log('tables now match the entities');
        console.log(
          `indexes, foreign keys, checks, triggers and grants: ` +
            `${report.applied} applied, ${report.existing} already present`,
        );
        console.log(
          report.stamped === 0
            ? 'migration ledger already up to date'
            : `recorded ${report.stamped} migration(s) as applied, so readiness passes`,
        );
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
