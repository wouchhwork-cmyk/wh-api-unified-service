/**
 * Seeds the global catalogue. Idempotent — safe to run repeatedly.
 *
 *   pnpm db:seed
 *
 * The logic lives in src/database/seed/catalogue.seed.ts so the test harness can
 * call it too; this file only owns the connection and the console output.
 */
import AppDataSource from '../src/database/data-source';
import { reportSeed, seedCatalogue } from '../src/database/seed/catalogue.seed';

async function main(): Promise<void> {
  await AppDataSource.initialize();
  try {
    const result = await AppDataSource.transaction((manager) => seedCatalogue(manager));
    reportSeed(result.summaries, result.insertedByRole);
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
