import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads .env.dev (then .env.local, which wins) into process.env, and points the
 * suite at its own database.
 *
 * Done here rather than with node --env-file because that path makes Node parse
 * the TypeScript itself, and its type stripping cannot handle the decorators the
 * entities rely on. Vitest's own transform can, so the env has to arrive through
 * a setup file instead.
 *
 * Shared by the per-file setup and the global setup: the global setup runs in a
 * SEPARATE module graph, so it does not inherit what the per-file setup did and
 * would otherwise provision a database at one name while the suites connect to
 * another.
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

/**
 * @param suffix which database this suite gets — see below for why it differs.
 */
export function loadTestEnv(suffix: '_test' | '_e2e' = '_test'): void {
  load('.env.dev', true);
  load('.env.local', false);

  /*
   * A DATABASE PER SUITE, AND NEVER THE DEVELOPMENT ONE.
   *
   * Never the development one because these suites TRUNCATE tenant data in
   * beforeEach, which is fine right up until somebody is clicking through the
   * portal while a run wipes the business they were looking at.
   *
   * Per SUITE because integration and e2e both truncate, and they interleave:
   * fileParallelism and maxWorkers serialise files WITHIN a project, and vitest
   * still runs projects alongside each other. Sharing one database, they wiped
   * each other's fixtures — and the symptom was the worst kind, an arbitrary
   * test failing perhaps one combined run in five and passing every time it ran
   * alone. Three different tests were caught that way before the cause was.
   *
   * Derived rather than configured, so a new environment cannot forget to set
   * it. TEST_DB_NAME overrides the base for a CI service container, and keeps
   * the per-suite suffix so the override cannot re-merge them.
   */
  const base = (process.env.TEST_DB_NAME ?? process.env.DB_NAME ?? 'wouchh_dev').replace(
    /_(dev|test|e2e)$/,
    '',
  );
  process.env.DB_NAME = `${base}${suffix}`;

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
}
