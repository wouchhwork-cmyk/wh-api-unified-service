import { DataSource } from 'typeorm';
import { seedCatalogue } from '@/database/seed/catalogue.seed';
import { buildDataSourceOptions } from '@/database/data-source';
import { loadConfiguration } from '@/config/configuration';

/**
 * Integration tests run against REAL POSTGRES, because every interesting
 * constraint in this schema is a Postgres feature a mock cannot reproduce: a
 * mocked repository would happily accept the duplicate that a partial unique
 * index rejects (backend-design.md §16).
 *
 * It connects to the database the environment names, so the same suite runs
 * against the local compose stack and against a CI service container without a
 * per-environment branch. Run with:
 *
 *   node --env-file=.env.dev ... or: pnpm test:integration
 */
export async function createTestDataSource(): Promise<DataSource> {
  const dataSource = new DataSource(buildDataSourceOptions(loadConfiguration().database));
  await dataSource.initialize();
  return dataSource;
}

/**
 * Clears tenant data between tests while KEEPING the seeded global catalogue —
 * features, permissions, and the role templates. Wiping those would make signup
 * fail with "the owner template is missing", which is a real behaviour worth
 * preserving rather than a test artefact.
 */
export async function truncateTenantData(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    TRUNCATE reward_entitlements, reward_ledger_entries, reward_wallets,
             reward_award_benefits, reward_awards, reward_cap_counters,
             reward_rule_conditions, reward_rule_benefits, reward_rules,
             reward_programs,
             entity_versions, audit_logs, message_attachments, messages, conversations, posts,
             customer_engagements, customer_identifiers, customers,
             verifications, outbound_events, inbound_events, sync_jobs,
             channels, provider_connections, sessions, enterprise_features,
             employee_roles, enterprise_employees, identities, enterprises,
             provider_api_usage
    RESTART IDENTITY CASCADE
  `);
  // employee_roles cascades from enterprises, but the ROLE rows a tenant owns are
  // its own copies of the templates and must go too — without removing the
  // templates themselves, which have enterprise_id IS NULL.
  await dataSource.query(`DELETE FROM roles WHERE enterprise_id IS NOT NULL`);

  /*
   * Re-seed the catalogue. TRUNCATE on enterprises CASCADEs into roles — which
   * carries a nullable enterprise_id — so the NULL-enterprise role TEMPLATES go
   * with it. Signup then fails with "the owner template is missing", which is
   * correct behaviour rather than a test artefact, so the fix is to restore the
   * catalogue instead of weakening the check.
   */
  await dataSource.transaction((manager) => seedCatalogue(manager));
}

/** A minimal enterprise, for tests that need a tenant but not a whole signup. */
export async function seedEnterprise(
  dataSource: DataSource,
  name: string,
  slug: string,
): Promise<number> {
  const rows: { id: string }[] = await dataSource.query(
    `INSERT INTO enterprises (name, slug, email) VALUES ($1, $2, $3) RETURNING id`,
    [name, slug, `hello@${slug}.test`],
  );
  return Number(rows[0]?.id);
}

/**
 * Normalises TypeORM's two RETURNING shapes, the same way BaseRepository.mutate
 * does.
 *
 * Verified against Postgres 18: `INSERT ... RETURNING` yields a FLAT row array,
 * while `UPDATE`/`DELETE ... RETURNING` yields the tuple `[rows, affected]`.
 * Tests that assert on raw SQL have to handle both, or they measure the shape
 * rather than the behaviour.
 */
export function returningRows<T>(result: unknown): T[] {
  if (Array.isArray(result) && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
}

/**
 * The scratch databases the two pre-deploy gates create and drop.
 *
 * An ALLOWLIST, not a convention. A database name cannot be a bound parameter —
 * Postgres has no placeholder for an identifier — so these statements
 * interpolate, which is the one thing this codebase forbids everywhere else.
 * Membership of this set is what makes the interpolation safe: an identifier
 * that is not one of these three never reaches the SQL, so no caller can aim
 * `DROP DATABASE` at `wouchh_dev` by passing a variable that turned out to hold
 * something else.
 */
const SCRATCH_DATABASES: ReadonlySet<string> = new Set([
  'wouchh_parity_migrated',
  'wouchh_parity_synced',
  'wouchh_migration_rehearsal',
]);

function assertScratchDatabase(name: string): void {
  if (!SCRATCH_DATABASES.has(name)) {
    throw new Error(`refusing to drop ${name}: not one of the suite's scratch databases`);
  }
}

/**
 * How long a scratch-database DDL statement may take.
 *
 * NOT the application's `DB_STATEMENT_TIMEOUT_MS`, and that distinction is the
 * whole point of this helper. Ten seconds is the right budget for a statement
 * serving an HTTP request — the database should give up before the HTTP layer
 * does. It is the WRONG budget for `DROP DATABASE`, which forces a checkpoint:
 * run straight after the full suite, with a dirty buffer pool and a run of WAL
 * to flush, the drop regularly takes longer than ten seconds and the CLIENT
 * gives up first.
 *
 * That is what the "flake" in this gate actually was. It presents as
 * `QueryFailedError: Query read timeout` inside `afterAll`, which vitest
 * reports as a FAILED FILE whose tests all passed — a shape that invites a
 * hunt for a leaked connection. `pg_stat_activity` showed none: the database
 * being dropped had nothing connected to it at all.
 *
 * Bounded rather than disabled. `statement_timeout = 0` would hang the suite
 * instead of failing it, and this sits comfortably under the 180s/300s hook
 * budgets the two gates already declare.
 */
const SCRATCH_DDL_TIMEOUT_MS = 120_000;

/**
 * The `postgres`-database connection the two pre-deploy gates issue their
 * CREATE and DROP from.
 *
 * One place, so both gates get the same timeout. They were each building this
 * inline from `buildDataSourceOptions`, which silently handed them the
 * application's request-sized budget.
 */
export async function createScratchAdminDataSource(): Promise<DataSource> {
  const base = buildDataSourceOptions(loadConfiguration().database);
  const admin = new DataSource({
    ...base,
    database: 'postgres',
    entities: [],
    migrations: [],
    extra: {
      ...base.extra,
      statement_timeout: SCRATCH_DDL_TIMEOUT_MS,
      query_timeout: SCRATCH_DDL_TIMEOUT_MS,
    },
  });
  await admin.initialize();
  return admin;
}

/**
 * Drops a scratch database, first evicting anything still connected to it.
 *
 * WHY THE EVICTION. `DROP DATABASE` refuses outright while any session is
 * connected — `database "x" is being accessed by other users` — and a run that
 * is killed partway (ctrl-C, a worker timeout, an editor restart) leaves
 * exactly that. The next run then fails in `beforeAll`, which vitest reports as
 * a failed FILE with its tests skipped rather than as a connection problem, and
 * it keeps failing until the orphaned backend dies on its own.
 *
 * This is bounded in a way a general-purpose helper would not be: it only ever
 * touches the three databases above, all of which this suite creates, owns and
 * drops within a single run. It never runs against a database holding anything
 * a person would miss.
 */
export async function dropScratchDatabase(admin: DataSource, name: string): Promise<void> {
  assertScratchDatabase(name);
  await admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
}

/** The same drop, followed by a fresh empty database of that name. */
export async function recreateScratchDatabase(admin: DataSource, name: string): Promise<void> {
  await dropScratchDatabase(admin, name);
  await admin.query(`CREATE DATABASE ${name}`);
}
