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
