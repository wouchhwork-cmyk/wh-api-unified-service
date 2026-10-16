// @ts-check
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

/**
 * ESLint 9 flat config.
 *
 * Composed from the configs @typescript-eslint/eslint-plugin already ships
 * rather than pulling in `typescript-eslint`, `@eslint/js` and `globals`: this
 * repository has a deliberate supply-chain policy (backend-design.md §5), and
 * three more packages in the tree to obtain three re-exports is a bad trade.
 *
 * TYPE-AWARE, on purpose. The rules worth having here — no-floating-promises
 * above all — cannot be expressed without type information, and this is a
 * service where an unawaited promise is a transaction that never commits or a
 * worker that reports success for work it abandoned. tsconfig.json already
 * covers src, test and scripts, so the type information is free.
 *
 * Formatting is NOT ESLint's job: prettier owns it, and prettierConfig turns off
 * every rule that would fight it.
 */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.mjs', 'scripts/*.js'],
  },

  tsPlugin.configs['flat/base'],
  tsPlugin.configs['flat/eslint-recommended'],
  ...tsPlugin.configs['flat/recommended-type-checked'],

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // Reads tsconfig.json for us, so the lint scope and the compile scope
        // cannot drift apart.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- the ones that catch real defects ------------------------------
      /**
       * An unawaited promise in this codebase is a transaction that never
       * commits, a lease never released, or an audit row silently skipped.
       * Deliberate fire-and-forget must say so with `void`.
       */
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      /** `if (somePromise)` is always true. Always a bug. */
      '@typescript-eslint/no-misused-promises': 'error',
      /** Silent failure is the hardest kind to diagnose from a support ticket. */
      'no-empty': ['error', { allowEmptyCatch: false }],
      /** Dead code and forgotten flags, per the coding guidelines. */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      /** Debug statements must not reach a commit; logging goes through pino. */
      'no-console': 'error',
      'no-debugger': 'error',
      /** `==` against null is the one useful loose comparison. */
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',

      // --- deliberately relaxed, with reasons ----------------------------
      /**
       * Raw SQL results, JWT payloads and Meta webhook bodies genuinely arrive
       * as `any`. The pattern this codebase uses is to accept that at the
       * boundary and narrow immediately — which these rules cannot see, and
       * which the type checker enforces anyway once narrowed.
       */
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      /**
       * `async` on a method with no await is normal in Nest: an interface or an
       * overridden hook may require the promise-returning signature.
       */
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    /*
     * Operator-facing output, where stdout IS the interface.
     *
     * A seed report routed through pino would be buried in JSON, and it lives
     * under src/ only because the migration and the app both need it. The two
     * entrypoints are here for a different reason: a startup failure can happen
     * BEFORE the logger exists, and "the port is in use" has to be readable
     * without a JSON parser.
     */
    files: [
      'scripts/**/*.ts',
      'src/database/seed/**/*.ts',
      'src/main.ts',
      // One-shot processes whose entire output is read from a terminal or a
      // deploy log, and which must say what they did before any logger exists.
      'src/migrate.ts',
      'src/export-openapi.ts',
      'src/workers/main.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },

  {
    files: ['test/**/*.ts'],
    rules: {
      /**
       * Tests reach into raw query results and response bodies constantly.
       * Requiring a type for every one would add noise without adding safety —
       * an assertion that passes on the wrong shape still fails the test.
       */
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },

  // Last, so it wins: prettier owns formatting.
  prettierConfig,
];
