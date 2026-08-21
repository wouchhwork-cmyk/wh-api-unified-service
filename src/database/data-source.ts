import { join } from 'node:path';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { loadConfiguration } from '@/config/configuration';
import type { DatabaseConfig } from '@/config/config.types';
import { SnakeNamingStrategy } from './naming.strategy';
// Side-effect import: registers the int8 parser before any connection opens.
import './pg-types';

/**
 * One options factory, used by both the Nest application and the CLI, so the
 * two can never disagree about how they connect or which migrations exist.
 */
export function buildDataSourceOptions(db: DatabaseConfig): DataSourceOptions {
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    database: db.name,
    username: db.user,
    password: db.password,
    ssl: db.ssl ? { rejectUnauthorized: true } : false,

    // NEVER true, in any environment. The synchroniser cannot represent the
    // partial unique indexes, expression indexes, composite foreign keys, CHECK
    // constraints, or gin_trgm_ops this schema depends on — and on boot it would
    // read them as drift and DROP them, silently deleting the tenant-isolation
    // and idempotency guarantees. Iteration speed comes from `pnpm db:reset`
    // instead (backend-design.md §5.1).
    synchronize: false,
    // Migrations run as a separate job, never on boot: N instances would race.
    migrationsRun: false,

    entities: [join(__dirname, 'entities', '*.entity.{ts,js}')],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'schema_migrations',

    // Implements schema.md's snake_case ↔ camelCase contract in ONE place.
    namingStrategy: new SnakeNamingStrategy(),

    // A query with no timeout is an outage waiting for traffic. The database
    // must give up BEFORE the HTTP layer, so the failure is a diagnosable
    // statement_timeout rather than an anonymous request abort.
    extra: {
      max: db.poolMax,
      statement_timeout: db.statementTimeoutMs,
      query_timeout: db.statementTimeoutMs,
      connectionTimeoutMillis: db.connectTimeoutMs,
      idleTimeoutMillis: db.idleTimeoutMs,
      application_name: 'wh-api-unified-service',
    },
  };
}

/**
 * The CLI DataSource. Only used by the scripts in scripts/db.ts — the running
 * application gets its DataSource from Nest's TypeOrmModule.
 */
const AppDataSource = new DataSource(buildDataSourceOptions(loadConfiguration().database));
export default AppDataSource;
