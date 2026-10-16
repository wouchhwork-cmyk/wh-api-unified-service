/**
 * Withdraws permissions a template dropped but tenants still hold.
 *
 *   node --env-file=.env.dev --import tsx scripts/prune-stale-grants.ts
 *   node --env-file=.env.dev --import tsx scripts/prune-stale-grants.ts --apply
 *
 * WHY THIS IS A SCRIPT AND NOT PART OF THE SEED. Reconciliation is additive on
 * purpose (todo E10): adding a permission a template gained is safe, and
 * removing one it lost takes something away from people who are using it right
 * now. That is a migration somebody decides to run, with a moment chosen for
 * it — not a side effect of whatever boot happened to come next.
 *
 * REPORTS BY DEFAULT. `--apply` is the only thing that writes, and it names
 * every row it removes on the way through, because the one question afterwards
 * is always "what exactly did that take away".
 */
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';

interface StaleGrant {
  id: string;
  enterpriseId: string;
  roleName: string;
  code: string;
}

const STALE_SQL = `
  SELECT rp.id, r.enterprise_id AS "enterpriseId", r.name AS "roleName", p.code
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = false
    JOIN permissions p ON p.id = rp.permission_id
    JOIN roles t
      ON t.enterprise_id IS NULL
     AND t.is_system = true
     AND t.is_deleted = false
     AND t.name = r.name
     AND t.scope = r.scope
   WHERE r.enterprise_id IS NOT NULL
     AND r.is_system = true
     AND r.is_deleted = false
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions trp
        WHERE trp.role_id = t.id
          AND trp.permission_id = rp.permission_id
          AND trp.is_deleted = false
     )
   ORDER BY r.enterprise_id, r.name, p.code
`;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();

  try {
    const stale: StaleGrant[] = await ds.query(STALE_SQL);

    if (stale.length === 0) {
      console.log('nothing stale — every tenant system role matches its template');
      return;
    }

    console.log(`${stale.length} grant(s) a template no longer defines:\n`);
    for (const row of stale) {
      console.log(`  enterprise ${row.enterpriseId}  ${row.roleName.padEnd(10)} ${row.code}`);
    }

    if (!apply) {
      console.log('\nnothing written. Re-run with --apply to withdraw them.');
      return;
    }

    /*
     * SOFT DELETE, like everything else in this schema. The row stays, so the
     * grant can be seen to have existed and restored by hand if withdrawing it
     * turns out to have been wrong.
     */
    const { rowCount } = await ds
      .query(
        `UPDATE role_permissions SET is_deleted = true, updated_at = now()
        WHERE id = ANY($1::bigint[]) AND is_deleted = false
        RETURNING id`,
        [stale.map((row) => row.id)],
      )
      .then((rows: unknown[]) => ({ rowCount: rows.length }));

    console.log(`\nwithdrawn ${rowCount} grant(s). Sessions already issued keep their claims`);
    console.log('until they are refreshed, so this takes full effect as tokens roll over.');
  } finally {
    await ds.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
