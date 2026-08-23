import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Vitest, not Jest: Nest v12 adopts Vitest, so choosing it now removes one of
// the four v12 migration axes (backend-design.md §1.1, §16).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    root: '.',
    /*
     * ONE FILE AT A TIME, ACROSS EVERY PROJECT.
     *
     * `fileParallelism: false` inside a project only serialises that project's
     * own files — projects still run concurrently with each other, and the
     * integration and e2e suites share one database and both TRUNCATE it in
     * beforeEach. Run in parallel they delete each other's fixtures, which
     * presents as a test that fails perhaps one run in three and passes when you
     * re-run it alone: the worst failure mode a suite can have.
     *
     * The honest fix is a database per suite. Until then this is what makes the
     * suite deterministic, and it costs a few seconds on a suite that runs in
     * under ten.
     */
    fileParallelism: false,
    maxWorkers: 1,
    /*
     * Creates the test database and syncs its schema before anything runs.
     *
     * Without it `pnpm test:all` on a fresh clone failed on a database nothing
     * had created: the harnesses connect straight to `<name>_test`, and the only
     * code that could create or shape one lived in scripts/db.ts pointed at the
     * DEVELOPMENT database. Running the suite was an undocumented two-step every
     * new machine — and every CI runner — had to be told about out of band.
     */
    globalSetup: ['test/global-setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.spec.ts', 'src/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts'],
          environment: 'node',
          setupFiles: ['test/env-setup.ts'],
          // Real Postgres via Testcontainers: every interesting constraint in this
          // schema is a Postgres feature a mock cannot reproduce (§16).
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.spec.ts'],
          environment: 'node',
          setupFiles: ['test/env-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
  resolve: {
    // fileURLToPath, not URL.pathname: the repository path contains a space and
    // pathname would hand vitest a percent-encoded directory that resolves to
    // nothing.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
