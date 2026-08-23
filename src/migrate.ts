import AppDataSource from '@/database/data-source';
import { loadConfiguration } from '@/config/configuration';

/**
 * The migration job, COMPILED — `node dist/migrate.js`.
 *
 * scripts/db.ts cannot do this job. It is excluded from tsconfig.build.json and
 * from .dockerignore, and `pnpm prune --prod` removes the tsx that runs it, so
 * the runtime image had no way to apply a migration at all. The deploy order the
 * design mandates — migrations first, then code — was therefore documented in
 * prose and impossible to execute.
 *
 * Deliberately NARROWER than the development CLI: it applies and it reports, and
 * that is all. There is no revert here and no sync, because the two commands
 * that can destroy a production database have no business being one typo away in
 * a production image.
 *
 *   node dist/migrate.js          apply everything pending
 *   node dist/migrate.js status   say whether anything is pending, change nothing
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  if (command !== 'up' && command !== 'status') {
    throw new Error(`Usage: migrate.js <up|status> (got "${command}")`);
  }

  const { database } = loadConfiguration();
  // Named every time, because a migration job pointed at the wrong database is
  // the one mistake here that cannot be undone.
  console.log(`target: ${database.user}@${database.host}:${database.port}/${database.name}`);

  await AppDataSource.initialize();
  try {
    if (command === 'status') {
      const pending = await AppDataSource.showMigrations();
      console.log(pending ? 'migrations are PENDING' : 'schema is up to date');
      // A non-zero exit lets a deploy pipeline gate on this without parsing text.
      process.exitCode = pending ? 1 : 0;
      return;
    }

    /*
     * One transaction for the whole set. A half-applied migration is the state
     * nothing can recover from automatically: the ledger disagrees with the
     * schema, so neither migrating nor reverting is safe.
     */
    const applied = await AppDataSource.runMigrations({ transaction: 'all' });
    if (applied.length === 0) {
      console.log('no pending migrations');
      return;
    }
    for (const migration of applied) console.log(`applied ${migration.name}`);
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  // Loud and non-zero: a deploy must stop here rather than roll code out over a
  // schema that never moved.
  process.exitCode = 1;
});
