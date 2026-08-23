import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads .env.dev (then .env.local, which wins) into process.env before any test
 * imports the config.
 *
 * Done here rather than with node --env-file because that path makes Node parse
 * the TypeScript itself, and its type stripping cannot handle the decorators the
 * entities rely on. Vitest's own transform can, so the env has to arrive through
 * a setup file instead.
 */
function load(file: string, required: boolean): void {
  let contents: string;
  try {
    contents = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch (error) {
    if (required) throw error;
    return;
  }

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;

    const key = trimmed.slice(0, equals).trim();
    // Strip an inline comment, then surrounding quotes.
    const raw = trimmed
      .slice(equals + 1)
      .replace(/\s+#.*$/, '')
      .trim();
    const value = raw.replace(/^["']|["']$/g, '');

    // Earlier files lose to later ones, and a real environment variable wins
    // over both — the same precedence the running service has.
    process.env[key] = value;
  }
}

load('.env.dev', true);
load('.env.local', false);

/*
 * TESTS GET THEIR OWN DATABASE, ALWAYS.
 *
 * The integration and e2e suites TRUNCATE tenant data in beforeEach. Pointed at
 * the development database that is fine right up until somebody is clicking
 * through the portal while a test run wipes the business they were looking at —
 * and it is worse against a permanent local install than a disposable container,
 * because there is no `down -v` to put it back.
 *
 * Derived rather than configured, so a new environment cannot forget to set it,
 * and overridable by a real TEST_DB_NAME for a CI service container.
 */
const devDatabase = process.env.DB_NAME ?? 'wouchh_dev';
process.env.DB_NAME = process.env.TEST_DB_NAME ?? `${devDatabase.replace(/_dev$/, '')}_test`;

/*
 * RATE LIMITING OFF, DELIBERATELY.
 *
 * The e2e suite signs in for almost every test, from one address, well inside a
 * minute — which is exactly the shape the credential throttle exists to refuse.
 * Leaving it on made the suite fail on whichever test happened to be eleventh,
 * which measures the limiter rather than the behaviour under test.
 *
 * That the limiter WORKS is covered separately, by asserting the routes carry
 * the tighter budget (test/unit/credential-throttle.spec.ts), and prod cannot
 * boot with this off.
 */
process.env.RATE_LIMIT_ENABLED = 'false';
