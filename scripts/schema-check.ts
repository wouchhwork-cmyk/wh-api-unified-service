/**
 * The entity ↔ database drift gate (backend-design.md §5.1).
 *
 * `typeorm schema:log` cannot gate CI: it prints the pending sync SQL and always
 * exits 0. This checks alignment directly and EXITS 1 on disagreement.
 *
 * It compares in both directions:
 *   - every entity column exists in the database, with the right nullability
 *   - every database column is mapped by an entity
 *
 * It deliberately does NOT compare indexes or constraints. The schema depends on
 * partial and expression indexes, composite foreign keys, and CHECK constraints
 * that entity metadata cannot represent — those would read as permanent drift.
 * Migrations own them, and the integration tests prove they work.
 *
 *   node --env-file=.env.dev --import tsx scripts/schema-check.ts
 */
import AppDataSource from '../src/database/data-source';

interface DbColumn {
  table_name: string;
  column_name: string;
  is_nullable: 'YES' | 'NO';
  data_type: string;
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const problems: string[] = [];

  try {
    const dbColumns = (await AppDataSource.query(
      `SELECT table_name, column_name, is_nullable, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`,
    )) as DbColumn[];

    const byTable = new Map<string, Map<string, DbColumn>>();
    for (const column of dbColumns) {
      let table = byTable.get(column.table_name);
      if (!table) {
        table = new Map<string, DbColumn>();
        byTable.set(column.table_name, table);
      }
      table.set(column.column_name, column);
    }

    const mappedTables = new Set<string>();

    for (const entity of AppDataSource.entityMetadatas) {
      const tableName = entity.tableName;
      mappedTables.add(tableName);
      const dbTable = byTable.get(tableName);

      if (!dbTable) {
        problems.push(`entity ${entity.name} maps table "${tableName}", which does not exist`);
        continue;
      }

      const mappedColumns = new Set<string>();
      for (const column of entity.columns) {
        mappedColumns.add(column.databaseName);
        const dbColumn = dbTable.get(column.databaseName);

        if (!dbColumn) {
          problems.push(
            `${tableName}.${column.databaseName} — declared by ${entity.name}.${column.propertyName}, ` +
              'absent from the database',
          );
          continue;
        }

        // A column the database requires but the entity thinks is optional is
        // the dangerous direction: an insert that omits it fails at runtime.
        const dbNullable = dbColumn.is_nullable === 'YES';
        if (column.isNullable && !dbNullable && !column.isGenerated && column.default === undefined) {
          problems.push(
            `${tableName}.${column.databaseName} — entity says nullable, database says NOT NULL`,
          );
        }
        if (!column.isNullable && dbNullable && !column.isPrimary) {
          problems.push(
            `${tableName}.${column.databaseName} — entity says NOT NULL, database says nullable`,
          );
        }
      }

      for (const dbColumn of dbTable.keys()) {
        if (!mappedColumns.has(dbColumn)) {
          problems.push(`${tableName}.${dbColumn} — exists in the database, mapped by no entity`);
        }
      }
    }

    for (const tableName of byTable.keys()) {
      if (!mappedTables.has(tableName)) {
        problems.push(`table "${tableName}" exists in the database, mapped by no entity`);
      }
    }

    const entityCount = AppDataSource.entityMetadatas.length;
    const columnCount = AppDataSource.entityMetadatas.reduce((n, e) => n + e.columns.length, 0);

    if (problems.length > 0) {
      console.error(`schema drift — ${problems.length} problem(s):\n`);
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `schema OK — ${entityCount} entities, ${columnCount} columns, ` +
        `${byTable.size} tables, no drift`,
    );
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
