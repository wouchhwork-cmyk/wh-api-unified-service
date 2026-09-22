import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '@/database/data-source';
import { loadConfiguration } from '@/config/configuration';
import { seedCatalogue } from '@/database/seed/catalogue.seed';
import { ROLE_LEVEL, SystemRole } from '@/shared/enums';

/**
 * A deploy rehearsal: the migrations, run against a database that already has a
 * business in it.
 *
 * WHY THIS IS NOT COVERED BY ANYTHING ELSE. `schema-parity.spec.ts` replays
 * every migration against an EMPTY database and compares the result to
 * `db:sync`, which is a question about shape. The whole test suite builds its
 * schema from the entities and seeds a fresh catalogue, which is a question
 * about a world that starts clean. Production is neither: it runs migrations in
 * order, over data that is already there, while the PREVIOUS release is still
 * serving traffic.
 *
 * That gap hid a real defect. `1758200000000-RoleLevels` adds a NOT NULL column
 * to `roles`, and the first attempt at making it deployable added it WITH a
 * default — which fills every existing row immediately, so the backfill keyed
 * on `level IS NULL` matched nothing and every role in every existing business
 * landed at the default. Owner at level 0: nobody outranks anybody, every
 * business locked out of managing its own team, and not one error anywhere to
 * say so. The full suite stayed green throughout, because a fresh database has
 * no rows to get wrong.
 *
 * RUN ON DEMAND, with `SCHEMA_PARITY=1`, alongside the other pre-deploy gate:
 * it creates and drops a database, which is not something to do on every watch.
 */
const SCRATCH = 'wouchh_migration_rehearsal';

/**
 * A migration class, as `data-source.ts` lists them.
 *
 * Spelled out rather than using `Function`, which lint refuses and which would
 * accept anything callable. The static `name` is what the filter reads.
 */
type MigrationClass = (new () => object) & { name: string };

/**
 * THIS release's migrations — the ones the rehearsal applies second.
 *
 * Named for what it holds rather than for how it is used. It was called
 * PREVIOUS_RELEASE and used negated, which reads backwards and hides the real
 * risk: a migration from this release left out of the list is applied during
 * the "previous release" phase instead, and the rehearsal silently covers
 * nothing for it.
 */
const THIS_RELEASE = /1758100000000|1758200000000|1758300000000/;

describe.skipIf(!process.env.SCHEMA_PARITY)('migrating a database that already has data', () => {
  let admin: DataSource;
  let db: DataSource;
  let enterpriseId: number;

  beforeAll(async () => {
    const base = buildDataSourceOptions(loadConfiguration().database);
    admin = new DataSource({ ...base, database: 'postgres', entities: [], migrations: [] });
    await admin.initialize();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
    await admin.query(`CREATE DATABASE ${SCRATCH}`);

    /*
     * THE WORLD AS THE PREVIOUS RELEASE LEFT IT. Only the migrations that
     * shipped before this one, and the tenant data written with RAW SQL —
     * because today's repositories write `level`, and reproducing a legacy
     * database through them would prove nothing.
     */
    const asShipped = ((base.migrations ?? []) as MigrationClass[]).filter(
      (migration) => !THIS_RELEASE.test(migration.name),
    );
    const previous = new DataSource({ ...base, database: SCRATCH, migrations: asShipped });
    await previous.initialize();
    await previous.runMigrations({ transaction: 'all' });

    await previous.query(
      `INSERT INTO roles (enterprise_id, scope, name, description, is_system, status)
       VALUES (NULL,'enterprise','owner','Full control',true,'active'),
              (NULL,'enterprise','manager','Most things',true,'active'),
              (NULL,'enterprise','agent','Works the inbox',true,'active'),
              (NULL,'enterprise','viewer','Read only',true,'active'),
              (NULL,'staff','support','Ours',true,'active'),
              (NULL,'staff','ops','Ours',true,'active')`,
    );
    const enterprise: { id: string }[] = await previous.query(
      `INSERT INTO enterprises (name, slug, email, country, timezone, status)
       VALUES ('Legacy Co','legacy','hello@legacy.test','IN','Asia/Kolkata','active')
       RETURNING id`,
    );
    enterpriseId = Number(enterprise[0]?.id);
    await previous.query(
      `INSERT INTO roles (enterprise_id, scope, name, description, is_system, status)
       SELECT $1, t.scope, t.name, t.description, true, 'active'
         FROM roles t WHERE t.enterprise_id IS NULL AND t.scope = 'enterprise'`,
      [enterpriseId],
    );
    await previous.destroy();

    // Now this release's migrations, on top of that.
    db = new DataSource({ ...base, database: SCRATCH });
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
  }, 300_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
      await admin.destroy();
    }
  }, 300_000);

  const levelOf = async (name: string): Promise<number | null> => {
    const rows: { level: number | null }[] = await db.query(
      `SELECT level FROM roles WHERE enterprise_id = $1 AND name = $2`,
      [enterpriseId, name],
    );
    return rows[0]?.level ?? null;
  };

  it('backfills every existing role from its name', async () => {
    /*
     * THE ASSERTION THAT CAUGHT IT. With the default attached at ADD COLUMN
     * time these all come back 0 — and 0 is a real level, so nothing fails, it
     * just silently means nobody outranks anybody.
     */
    expect(await levelOf(SystemRole.Owner)).toBe(ROLE_LEVEL.Owner);
    expect(await levelOf(SystemRole.Manager)).toBe(ROLE_LEVEL.Manager);
    expect(await levelOf(SystemRole.Agent)).toBe(ROLE_LEVEL.Agent);
    expect(await levelOf(SystemRole.Viewer)).toBe(ROLE_LEVEL.Viewer);
  });

  it('leaves no role without a level', async () => {
    const rows: { count: string }[] = await db.query(
      `SELECT count(*)::text AS count FROM roles WHERE level IS NULL`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('lets the PREVIOUS release keep inserting roles during the rollover', async () => {
    /*
     * Migrations land before the code that needs them, so for the length of a
     * deploy the old release is still serving against the new column. The old
     * `instantiateSystemRoles` — which is the signup path — inserts a role
     * without naming `level`. Against NOT NULL with no default that fails, and
     * every new business signup breaks for the duration of the deploy.
     */
    /*
     * `.resolves` is the assertion that bites; `.not.toThrow()` after it is a
     * no-op against a resolved array and was misleading about what is checked.
     */
    await expect(
      db.query(
        `INSERT INTO roles (enterprise_id, scope, name, description, is_system, status)
         VALUES ($1,'enterprise','as-the-old-code-writes-it','legacy',false,'active')`,
        [enterpriseId],
      ),
    ).resolves.toBeDefined();
  });

  it('gives a role inserted without a level the BOTTOM of the ladder', async () => {
    // Never the top. An inert role is a support ticket; one that outranked
    // everybody would be an incident.
    const rows: { level: number }[] = await db.query(
      `SELECT level FROM roles WHERE enterprise_id = $1 AND name = 'as-the-old-code-writes-it'`,
      [enterpriseId],
    );
    expect(rows[0]?.level).toBe(0);
    expect(rows[0]?.level).toBeLessThan(ROLE_LEVEL.Viewer);
  });

  it('brings the legacy business up to date when the new seed runs', async () => {
    /*
     * The other half of a deploy: the seed runs after the migrations, and
     * reconciliation is what carries this release's new permissions to a
     * business that signed up under the last one (backlog B2).
     */
    const report = await db.transaction((manager) => seedCatalogue(manager));

    expect(report.reconciled.grantsAdded).toBeGreaterThan(0);

    const rows: { name: string; count: string }[] = await db.query(
      `SELECT r.name, count(rp.permission_id)::text AS count
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.enterprise_id = $1 AND r.is_system = true
        GROUP BY r.name`,
      [enterpriseId],
    );
    const byName = new Map(rows.map((row) => [row.name, Number(row.count)]));

    // The legacy copies arrived with no grants at all; they now match the
    // templates, owner widest.
    expect(byName.get(SystemRole.Owner)).toBeGreaterThan(20);
    expect(byName.get(SystemRole.Owner)).toBeGreaterThan(byName.get(SystemRole.Viewer) ?? 0);
  });

  it('is idempotent, so a re-run of the seed changes nothing', async () => {
    const again = await db.transaction((manager) => seedCatalogue(manager));

    expect(again.reconciled).toEqual({ rolesAdded: 0, grantsAdded: 0, levelsCorrected: 0 });
  });
});
