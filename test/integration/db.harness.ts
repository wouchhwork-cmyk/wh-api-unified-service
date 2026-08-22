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
    TRUNCATE audit_logs, message_attachments, messages, conversations, posts,
             customer_engagements, customer_identifiers, customers,
             verifications, outbound_events, inbound_events, sync_jobs,
             channels, provider_connections, sessions, enterprise_features,
             member_roles, enterprise_members, identities, enterprises
    RESTART IDENTITY CASCADE
  `);
  // member_roles cascades from enterprises, but the ROLE rows a tenant owns are
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
  const rows = (await dataSource.query(
    `INSERT INTO enterprises (name, slug, email) VALUES ($1, $2, $3) RETURNING id`,
    [name, slug, `hello@${slug}.test`],
  )) as { id: string }[];
  return Number(rows[0]?.id);
}
