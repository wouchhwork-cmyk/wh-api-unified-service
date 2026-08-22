/**
 * Database CLI. Run with Node's own --env-file so there is exactly one way the
 * environment is populated:
 *
 *   node --env-file=.env.dev --import tsx scripts/db.ts migrate
 */
import AppDataSource from '../src/database/data-source';

type Command = 'migrate' | 'revert' | 'drop' | 'status';

const COMMANDS: readonly Command[] = ['migrate', 'revert', 'drop', 'status'];

function parseCommand(raw: string | undefined): Command {
  if (raw && (COMMANDS as readonly string[]).includes(raw)) return raw as Command;
  throw new Error(`Usage: db.ts <${COMMANDS.join('|')}>`);
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);

  if (
    command === 'drop' &&
    (process.env.NODE_ENV === 'prod' || process.env.NODE_ENV === 'production')
  ) {
    throw new Error('refused: db drop is never allowed with NODE_ENV=prod');
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
