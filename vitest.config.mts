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
     * Creates every suite's database and syncs its schema before anything runs.
     *
     * AT THE ROOT, not per project: a project-scoped globalSetup does not run
     * early enough — the harness opened its connection first and failed on a
     * database that had not been created yet. The cost is one connection on
     * behalf of the unit suite, which needs none; the gain is a suite that works
     * from a clean checkout instead of an undocumented two-step.
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
          // Real Postgres: every interesting constraint in this schema is a
          // Postgres feature a mock cannot reproduce (§16).
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
          maxWorkers: 1,
          minWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.spec.ts'],
          environment: 'node',
          /*
           * Its OWN database, not the integration suite's: both TRUNCATE in
           * beforeEach, and vitest runs projects alongside each other.
           *
           * A fork-per-file pool used to be configured here as well, to stop
           * files contaminating each other. It was a workaround for a
           * misdiagnosis — the real cause was the harness never binding its HTTP
           * server, so supertest bound and unbound it per request and
           * body-parser occasionally saw a socket that had gone away mid-body.
           * See test/e2e/app.harness.ts.
           */
          setupFiles: ['test/env-setup-e2e.ts'],
          /*
           * A PROCESS PER FILE, and one file at a time.
           *
           * Every file here boots the whole application — guards, interceptors,
           * a LISTEN client, a scheduler — and closes it again. Sharing a worker
           * process across files meant one file's teardown could land while
           * another's request was in flight, which presented as `socket hang up`
           * in an arbitrary test about one combined run in seven, and passed
           * every time that file ran alone.
           *
           * A fork per file cannot leak anything to the next one, whatever a
           * shutdown hook forgets.
           */
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
          maxWorkers: 1,
          minWorkers: 1,
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
