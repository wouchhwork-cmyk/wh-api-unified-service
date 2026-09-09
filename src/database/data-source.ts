import { DataSource, type DataSourceOptions } from 'typeorm';
import { loadConfiguration } from '@/config/configuration';
import type { DatabaseConfig } from '@/config/config.types';
import { ENTITIES } from './entities';
import { InitialSchema1756000000000 } from './migrations/1756000000000-InitialSchema';
import { ConversationResync1757000000000 } from './migrations/1757000000000-ConversationResync';
import { RepairConversationCounts1757100000000 } from './migrations/1757100000000-RepairConversationCounts';
import { WidenDedupKey1757200000000 } from './migrations/1757200000000-WidenDedupKey';
import { RepairInboundReceivedAt1757300000000 } from './migrations/1757300000000-RepairInboundReceivedAt';
import { MentionParentLink1757400000000 } from './migrations/1757400000000-MentionParentLink';
import { MarkTextlessComments1757500000000 } from './migrations/1757500000000-MarkTextlessComments';
import { SnakeNamingStrategy } from './naming.strategy';
// Side-effect import: registers the int8 parser before any connection opens.
import './pg-types';

/**
 * One options factory, used by both the Nest application and the CLI, so the
 * two can never disagree about how they connect or which migrations exist.
 *
 * Narrowed to postgres rather than returning the bare DataSourceOptions union.
 * That union spans every driver TypeORM supports, so spreading the result to
 * override one field — which the parity test does to point at a scratch database
 * — widens it back across all of them, and `database` becomes a Uint8Array in
 * the sql.js branch.
 */
export function buildDataSourceOptions(
  db: DatabaseConfig,
): DataSourceOptions & { type: 'postgres' } {
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

    // Explicit lists, never globs: TypeORM resolves globs at runtime and
    // requires the files itself, which bypasses the build's transform.
    entities: [...ENTITIES],
    /*
     * IN ORDER, and every one of them listed. The list is explicit rather than
     * a glob, which is deliberate — but it also means a migration file that
     * nobody adds here is dead: `migrate` reports "no pending migrations" and
     * the change silently never reaches any database. Both of the entries below
     * were written and, until this line, would never have run.
     */
    migrations: [
      InitialSchema1756000000000,
      ConversationResync1757000000000,
      RepairConversationCounts1757100000000,
      WidenDedupKey1757200000000,
      RepairInboundReceivedAt1757300000000,
      MentionParentLink1757400000000,
      MarkTextlessComments1757500000000,
    ],
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
