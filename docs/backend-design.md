# Wouchh — Backend Code Design

Companion to [`schema.md`](./schema.md). That document decides the data. This one decides the code: framework and versions, module layout, configuration, data access, transactions, auth, API contract, observability, deployment, and the supply-chain policy that protects all of it.

Every choice here is written with its reasoning, because a design doc that only lists conclusions cannot be argued with when the conclusions age.

---

## 1. Stack and versions

Checked against the ecosystem in **August 2026**. Verify each with `npm view <pkg> version` at scaffold time — these move.

| Concern | Choice | Version | Why this one |
| ------- | ------ | ------- | ------------ |
| Runtime | **Node.js** | **24.x (Active LTS)** | Node 20 went EOL in April 2026; 22 is only in Maintenance. 24 is the current Active LTS. Node 26 is Current but does not enter Active LTS until October 2026 — a production service should not run a Current release |
| Framework | **NestJS** | **11.2.x** | **Not v12 — see below** |
| Language | **TypeScript** | 5.x, `strict: true` | Non-negotiable: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Transpile | **SWC** (Nest 11 default) | — | Default since v11; roughly an order of magnitude faster than `tsc` for builds. Type-checking still runs separately in CI |
| ORM | **TypeORM** | **1.1.x** | See §1.2 |
| Driver | `pg` | 8.x | |
| Validation | **Zod** via `nestjs-zod` | latest | See §1.3 |
| API docs | `@nestjs/swagger` | 11.x | |
| Background work | **Postgres ledger polling** — `@nestjs/schedule` + `FOR UPDATE SKIP LOCKED` | — | **No Redis in V1, by decision.** The ledger tables are the queue (§12) |
| Logging | **pino** via `nestjs-pino` | latest | Structured JSON, low overhead |
| Package manager | **pnpm** | 10.x | Chosen for a security feature — §2 |
| Container | Alpine multi-stage | — | §14 |

### 1.1 Why NestJS 11, not 12

NestJS **v12.0.0 landed on 14 August 2026** — roughly a week before this document. It is a genuinely good release, and it is the wrong choice for day one of a product.

What v12 changes: a **full CommonJS → ESM migration** across every official package, **Standard Schema validation** replacing `class-validator` as the default, and a **toolchain swap** — Vitest for Jest, oxlint for ESLint, Rspack for Webpack. That is four simultaneous foundation changes.

The reasoning against adopting it now:

- **It is one week old.** The v11 → v12 migration guide was still unpublished as of the roadmap announcements. Being the team that discovers the migration's rough edges is a poor use of the first sprint.
- **The ecosystem trails the framework.** `@nestjs/typeorm`, `@nestjs/swagger`, `@nestjs/terminus`, and the Passport strategies all need to follow. A gap in any one of them blocks a feature, and the workaround is usually worse than the version bump would have been.
- **v11 is not a compromise.** SWC is already the default, so builds are fast. It is the version every current tutorial, Stack Overflow answer, and LLM training set knows — which matters more for velocity than it should.
- **The upgrade is designed to be cheap.** The ESM migration is deliberately built on Node's `require(esm)` support, so v12 is explicitly not intended to break existing projects. Waiting costs little.

**Plan:** ship on 11.2.x, and schedule the v12 evaluation for roughly one quarter out, once the migration guide exists and the ecosystem has caught up. Two things — Zod validation (§1.3) and Vitest (§16) — are chosen specifically to make that upgrade small.

### 1.2 Why TypeORM is defensible now

TypeORM spent years in a maintenance limbo that made it a questionable default. That changed: new maintainers took over at the end of 2024, and **TypeORM 1.0 shipped in June 2026** after nearly a decade on 0.x, followed by 1.1.0 in July. Through 2025 the team merged 575 PRs against 63 the year before and closed over 2,300 issues.

So the choice is sound today, with one important constraint from `schema.md`: **the schema uses Postgres features TypeORM cannot model** — partial unique indexes, composite foreign keys through `enterprise_id`, `COALESCE(...)` expression indexes, `gin_trgm_ops`. That does not disqualify TypeORM; it dictates how it is used. See §5.

### 1.3 Validation: Zod, not class-validator

`class-validator` is the v11 default and the conservative pick. **Zod via `nestjs-zod` is the better one here**, for two reasons specific to this project:

1. **It satisfies requirement 10 for free.** A Zod schema *is* the type — `z.infer<typeof CreateEnterpriseSchema>` — so the request/response contract, the runtime validator, and the OpenAPI schema all come from one declaration. With `class-validator` the type and the validation rules are two things that drift.
2. **It is where v12 is going.** v12 makes Standard Schema (Zod, Valibot, ArkType) native in `@Body`/`@Query`/`@Param` and collapses the community wrappers into a framework-level `ValidationPipe`. Adopting Zod now means the v12 validation migration is deleting a wrapper, not rewriting every DTO.

**Risk accepted:** `nestjs-zod` is a community package. It is widely used and its role is being absorbed into the framework, which de-risks rather than strands it. If a hard gap appears, `class-validator` remains available in the same app — the fallback is per-endpoint, not a rewrite.

---

## 2. Supply-chain security policy

This is first, not last, because npm is currently the most likely way this service gets compromised — and because dev dependencies are as dangerous as runtime ones.

**2026 has been unusually bad.** The `keyv`/`cacheable` compromise on 4 August 2026 hijacked a maintainer's GitHub account and published malicious versions across a namespace with roughly 127M weekly downloads. It swept up `flat-cache` (~565M downloads/month) and `file-entry-cache` (~557M/month) — both **transitive dependencies of ESLint**. The payload was a `preinstall` hook that downloaded a Bun runtime, harvested cloud and CI credentials, and republished trojanised versions of other packages. Over 1,300 package versions were affected, and earlier in the year `axios` and `@redhat-cloud-services` were hit. The self-replicating **Shai-Hulud** worm is the pattern these now follow.

Three facts drive the policy: the attack ran in an **install hook**, it targeted **CI credentials**, and it arrived through a **dev dependency**.

### The rules

| Rule | Mechanism | Stops |
| ---- | --------- | ----- |
| **Install scripts are off by default** | `.npmrc`: `ignore-scripts=true`; allowlist the few packages that genuinely need them | The exact vector used in the keyv attack |
| **Nothing brand new gets installed** | pnpm's `minimumReleaseAge` — refuse any version published less than **72 hours** ago (verify the setting name for the installed pnpm) | Malicious versions are usually detected and unpublished within hours. This alone would have blocked the August incident |
| **Exact versions, no ranges** | `save-exact=true`. No `^`, no `~`, in either dependency block | A hijacked patch release cannot arrive silently |
| **Lockfile is law** | `pnpm install --frozen-lockfile` everywhere, including local. Lockfile committed and reviewed in PRs | Drift between what was audited and what installs |
| **Dependency changes are reviewed like code** | A PR touching `package.json` or the lockfile needs a human who looks at *what changed and who publishes it* | Blind Dependabot auto-merge |
| **Scanning in CI** | `pnpm audit` plus a supply-chain scanner (Socket or Snyk) as a blocking check | Known-bad versions |
| **Provenance preferred** | Prefer packages published with npm provenance / trusted publishing | Account-takeover publishes |
| **CI has no standing credentials** | Short-lived OIDC tokens, no long-lived registry or cloud keys in the environment | The credential harvest that made the attack profitable |
| **Builds do not reach the internet** | Production image builds run with the network restricted to the registry mirror | Second-stage payload downloads |

**Why pnpm.** Not preference — `minimumReleaseAge` is the single highest-leverage mitigation available, and it is a package-manager feature. A cooldown window turns "we installed it the hour it was published" into "the ecosystem had three days to notice", which is how nearly every one of these incidents was actually caught.

**Runtime hardening that assumes a compromise anyway** (§14): the container runs as a non-root user with a read-only filesystem, holds no cloud credentials it does not need, and reaches only the hosts it must.

---

## 3. Repository layout

Layering follows one rule: **Controller → Service → Repository → DB, one direction, no reverse calls.** Business logic lives only in services. Controllers parse, call, map, and nothing else. Repositories hold persistence and query logic and no business rules.

```
src/
  main.ts                       # bootstrap, global pipes/filters/interceptors, shutdown hooks
  app.module.ts

  config/                       # centralised configuration — nothing reads process.env elsewhere
    configuration.ts            # typed config factory
    env.schema.ts               # Zod schema; the app refuses to boot on a bad env
    config.types.ts

  shared/
    enums/                      # every enum in the product, one file per domain (§11)
    constants/                  # limits, timeouts, window sizes — no magic numbers
    errors/
      error-codes.enum.ts       # the machine-readable catalogue (§8.2)
      app.exception.ts          # the one exception type services throw
    contracts/                  # request/response schemas + inferred types (§9)
    decorators/                 # @CurrentActor, @RequirePermission, @Public
    guards/                     # JwtAuthGuard, EnterpriseScopeGuard, PermissionsGuard
    interceptors/               # ResponseEnvelope, Timeout, Logging
    filters/                    # AllExceptionsFilter
    pipes/
    utils/
      normalize/                # email / mobile / slug normalisation (schema.md §Input normalization)
    context/                    # AsyncLocalStorage request context (correlationId, actor)

  database/
    data-source.ts              # TypeORM DataSource, used by both app and CLI
    migrations/                 # hand-written SQL migrations, timestamp-ordered
    entities/                   # TypeORM entities, one per table
    repositories/               # one repository per aggregate
    transaction/
      transaction.manager.ts    # the only place a transaction is opened (§6)

  modules/
    auth/                       # login, refresh, verify, switch-enterprise
    identities/
    enterprises/
    employees/                    # enterprise_employees + roles + permissions
    features/                   # features + enterprise_features
    connections/                # provider_connections + channels
    sync/                       # sync_jobs + workers
    customers/                  # customers + identifiers + engagements
    posts/
    conversations/
    messages/
    ledger/                     # inbound_events / outbound_events, relay + projectors
    audit/                      # audit_logs write path (schema.md §25): INSERT-only AuditService,
                                #   called by services inside their transactions; no controller in
                                #   V1 — the staff read surface lives in admin/
    health/
    admin/                      # staff-only surface

  workers/                      # ledger pollers + sweepers; separate bootstrap from the HTTP app

test/
  unit/  integration/  e2e/
```

Each module is `<name>.module.ts` + `<name>.controller.ts` + `<name>.service.ts` + `dto/`, with repositories living in `database/repositories` so a service can compose several without a circular module import.

**Workers get their own entrypoint.** The HTTP app and the workers share modules but boot separately, so a backlog of sync jobs cannot starve the API, and each scales independently.

---

## 4. Configuration and environments

### 4.1 Three environments, one loading rule

| Environment | Config source |
| ----------- | ------------- |
| `dev` | `.env.dev`, committed — **no real secrets** |
| `qa` | `.env.qa`, committed — **no real secrets** |
| `prod` | **Nothing in the repo.** Injected by the deployment platform |

The rule: `.env.dev` and `.env.qa` exist for local and shared-test convenience and contain only values that are safe in git — hostnames, ports, feature flags, timeouts. Anything genuinely secret is referenced by name and supplied at runtime, in **every** environment including dev. A `.env.dev` that works with no extra setup is a `.env.dev` that will eventually hold a real key.

```
.env.dev          committed, non-secret
.env.qa           committed, non-secret
.env.local        gitignored — developer's own secrets, overrides .env.dev
.env.example      the documented full list of variables
```

### 4.2 Fail fast on bad configuration

Configuration is validated with Zod at boot. A missing or malformed variable **stops the process**; it does not default to something plausible.

```ts
// config/env.schema.ts
export const EnvSchema = z.object({
  NODE_ENV:      z.enum(['dev', 'qa', 'prod']),
  PORT:          z.coerce.number().int().positive().default(3000),
  APP_VERSION:   z.string().default('dev'),

  DB_HOST:       z.string().min(1),
  DB_PORT:       z.coerce.number().int().positive(),
  DB_NAME:       z.string().min(1),
  DB_USER:       z.string().min(1),
  DB_PASSWORD:   z.string().min(1),
  DB_SSL:        z.enum(['true', 'false']).transform(v => v === 'true'),
  DB_POOL_MAX:   z.coerce.number().int().positive().default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  JWT_ACCESS_SECRET:   z.string().min(32),
  JWT_ACCESS_TTL:      z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),

  TOKEN_ENCRYPTION_KEY_ID: z.string().min(1),   // schema.md §14 envelope
  VERIFICATION_HMAC_PEPPER: z.string().min(32), // schema.md §12

  ARGON2_MEMORY_KIB:   z.coerce.number().int().positive().default(19_456), // §7.3
  ARGON2_ITERATIONS:   z.coerce.number().int().positive().default(2),
  ARGON2_PARALLELISM:  z.coerce.number().int().positive().default(1),

  EXPIRY_WARNING_WINDOW_DAYS: z.coerce.number().int().positive().default(7), // schema.md §10, §14 sweeps
  EXPIRY_SWEEP_CRON:          z.string().default('0 * * * *'),

  // Meta integration (§18)
  FB_APP_ID:                z.string().min(1),
  FB_APP_SECRET:            z.string().min(1),
  FB_LOGIN_CONFIG_ID:       z.string().min(1),
  GRAPH_API_VERSION:        z.string().regex(/^v\d+\.\d+$/).default('v25.0'),
  META_OAUTH_REDIRECT_URI:  z.string().url(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(16),
  FRONTEND_DASHBOARD_URL:   z.string().url(),

  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  WORKER_BATCH_SIZE:       z.coerce.number().int().positive().default(20),
  WORKER_LEASE_SECONDS:    z.coerce.number().int().positive().default(120),
  LOG_LEVEL:     z.enum(['fatal','error','warn','info','debug','trace']).default('info'),
});
export type Env = z.infer<typeof EnvSchema>;
```

Per-kind verification parameters (secret shape, expiry, max attempts, resend cooldown, per-destination hourly cap — schema.md §12) are **structured config, not flat env vars**: a typed map keyed by `VerificationKind` in `config/verification.config.ts`, with env overrides only where an environment genuinely differs.

`process.env` is read in exactly one file. Everything else injects `ConfigService`. A `process.env` reference outside `config/` is a lint error.

### 4.3 `.vscode/launch.json`

Three launch configurations, plus one for workers, one that attaches to a running container, and one for the current test file.

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "API · dev",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["run", "start:debug"],
      "envFile": "${workspaceFolder}/.env.dev",
      "env": { "NODE_ENV": "dev" },
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"],
      "autoAttachChildProcesses": true
    },
    {
      "name": "API · qa",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["run", "start:debug"],
      "envFile": "${workspaceFolder}/.env.qa",
      "env": { "NODE_ENV": "qa" },
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "API · prod (local, env from shell)",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["run", "start:prod"],
      "env": { "NODE_ENV": "prod" },
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Workers · dev",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["run", "start:workers:debug"],
      "envFile": "${workspaceFolder}/.env.dev",
      "env": { "NODE_ENV": "dev" },
      "console": "integratedTerminal"
    },
    {
      "name": "Attach to running container",
      "type": "node",
      "request": "attach",
      "port": 9229,
      "address": "localhost",
      "localRoot": "${workspaceFolder}",
      "remoteRoot": "/app",
      "restart": true
    },
    {
      "name": "Vitest · current file",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["vitest", "run", "${relativeFile}"],
      "envFile": "${workspaceFolder}/.env.dev",
      "console": "integratedTerminal"
    }
  ]
}
```

**Note the `prod` configuration deliberately has no `envFile`.** It runs with whatever the shell provides, which is the same contract as the deployment. If it fails locally because a variable is missing, that is the configuration validation doing its job.

---

## 5. Data access — one mechanism, one escape hatch

**Decision: TypeORM is the only way this application talks to Postgres. Raw SQL is permitted, but only inside a repository, and only where the query builder genuinely cannot express the query.**

The three candidates, and why this one:

| Option | Verdict |
| ------ | ------- |
| **Pure TypeORM** — entities and query builder only | Rejected. It cannot express what `schema.md` needs: `ON CONFLICT ... WHERE` against partial unique indexes, `FOR UPDATE SKIP LOCKED` for the ledger claim, recursive CTEs for reply chains, `COALESCE(...)` unique targets |
| **Raw SQL in `.sql` files**, loaded and executed | Rejected. No type safety, no compile-time link between a query and the entity it returns, and renaming a column becomes a grep. Refactors go silently wrong, which is the worst failure mode for a data layer |
| **TypeORM-first with a confined raw escape hatch** | **Chosen** |

### Why one mechanism matters more than which one

Tenant scoping, query timeouts, soft-delete filtering, and slow-query logging all have to be enforced *somewhere*. With one access path they are enforced once, in the repository base class. With two, every cross-cutting concern is implemented twice and the second implementation is where `enterprise_id` gets forgotten — which in this product is a cross-tenant data leak.

### The rules

1. **Simple reads and single-row writes** use the repository API: `findOne`, `save`, `update` with explicit column lists.
2. **Anything with joins, filters, or pagination** uses `createQueryBuilder`, so the SQL is typed and the entity mapping is checked.
3. **Raw SQL** via `queryRunner.query()` is allowed **only** in a repository method, **only** with bound parameters (`$1`, `$2` — never interpolation), and the method must be named for what it does, not for how. The known cases are few and all of them come from `schema.md`:
   - claiming ledger work — `FOR UPDATE SKIP LOCKED`
   - upserts onto partial unique indexes — `ON CONFLICT (...) WHERE ... DO UPDATE`
   - the `COALESCE(enterprise_id, 0)` dedup conflict target
   - trigram customer search
   - reply-chain traversal — recursive CTE
4. **No query builder or raw SQL above the repository layer.** A service that contains SQL is a bug, not a shortcut. Enforced by lint rule and code review.
5. **Every repository method takes `enterpriseId` explicitly** for tenant-scoped tables, and it comes from the request context, never from a request body.
6. **No `SELECT *`.** Explicit column selection, always, so adding a column cannot silently widen a hot query or leak an encrypted token.

Two wiring details that implement `schema.md`'s contracts:

- **The snake_case ↔ camelCase mapping is a `SnakeNamingStrategy` set once on the DataSource.** Entities use camelCase properties with no per-column `name:` overrides — the mapping stays mechanical and lossless, exactly as the schema's naming contract requires. A per-column alias is a review rejection.
- **`BIGINT` ids are `number` in code, made safe explicitly.** The `pg` driver returns `int8` as a **string** by default (a bigint can exceed `Number.MAX_SAFE_INTEGER`), which means untreated ids silently fail `===` against numbers. One type-parser registration converts `int8` to `number` and **throws** past `MAX_SAFE_INTEGER` — turning a theoretical overflow at 9 quadrillion rows into a loud error instead of silent precision loss.

```ts
// database/repositories/customer-identifier.repository.ts
async resolveByIdentifier(
  enterpriseId: number, kind: IdentifierKind, value: string,
): Promise<{ customerId: number } | null> {
  // Raw: the index this must hit is partial, and the query has to match its predicate.
  const rows = await this.manager.query<{ customer_id: number }[]>(
    `SELECT customer_id
       FROM customer_identifiers
      WHERE enterprise_id = $1 AND identifier_kind = $2 AND identifier_value = $3
        AND status = 'active' AND is_deleted = false
      LIMIT 1`,
    [enterpriseId, kind, value],
  );
  return rows[0] ? { customerId: rows[0].customer_id } : null;
}
```

### 5.1 Migrations are hand-written SQL, and `synchronize` is off

**`synchronize: true` must be `false` in every environment, including local dev.** You asked for it on, so here is the specific reason it cannot be:

TypeORM's schema synchroniser generates DDL from entity metadata. It has **no representation** for most of what `schema.md` relies on:

- partial unique indexes (`WHERE is_deleted = false`, `WHERE status = 'active'`, `WHERE platform_message_id IS NOT NULL`)
- expression indexes (`lower(email)`, `COALESCE(enterprise_id, 0)`)
- composite foreign keys routed through `enterprise_id` — the mechanism that makes cross-tenant references unrepresentable
- `CHECK` constraints (the at-least-one-credential rule, the verification subject rule)
- `gin_trgm_ops` operator classes

That is not merely "it won't create them". On the next boot the synchroniser sees indexes and constraints it did not generate, concludes they are drift, and **issues `DROP`**. Enabling it would delete the tenant-isolation guarantees and the idempotency guards — silently, at startup, with no migration to review.

**What you actually want from `synchronize` is fast iteration, and that comes from tooling instead:**

```jsonc
"db:migrate":        "typeorm migration:run -d dist/database/data-source.js",
"db:revert":         "typeorm migration:revert -d dist/database/data-source.js",
"db:drop":           "node scripts/assert-not-prod.js && typeorm schema:drop -d dist/database/data-source.js",
"db:reset":          "pnpm db:drop && pnpm db:migrate && pnpm db:seed",  // dev only, ~2s
"db:seed":           "ts-node scripts/seed.ts",
"db:check":          "node scripts/schema-check.js" // drift gate — exits 1 on disagreement
```

Two of those scripts need real implementations, because the bare CLI cannot do what the comments promise: `scripts/assert-not-prod.js` is the drop guard (`if (process.env.NODE_ENV === 'prod') { console.error('refused: NODE_ENV=prod'); process.exit(1); }` — and since `db:reset` chains `db:drop`, one guard covers both), and `scripts/schema-check.js` is the drift gate — `typeorm schema:log` always exits 0, so the script initialises the DataSource, calls `createSchemaBuilder().log()`, filters out the DB-only objects entity metadata cannot represent (the partial/expression indexes, composite FKs, and CHECK constraints above, which would otherwise read as perpetual drift), and exits 1 if any real difference remains.

`db:reset` gives the same loop as `synchronize` — change the schema, run one command, get a clean database — while the migration stays the single source of truth and review still sees the DDL.

Migrations are **hand-written SQL** inside TypeORM migration classes, never generated:

```ts
export class AddCustomerIdentifiers1756000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE customer_identifiers (...)`);
    await q.query(`CREATE UNIQUE INDEX customer_identifiers_value_uniq
                     ON customer_identifiers (enterprise_id, identifier_kind, identifier_value)
                     WHERE status = 'active' AND is_deleted = false`);
  }
  public async down(q: QueryRunner): Promise<void> { /* explicit, tested */ }
}
```

Rules: every migration has a real `down`; each is **expand/contract** so deploys stay backward compatible (add column → deploy code → backfill → drop old column, as separate releases); indexes on populated tables use `CREATE INDEX CONCURRENTLY` in a migration marked `transaction = false`; and backfills over large tables are batched and throttled rather than a single `UPDATE`. The first migration also creates the `updated_at` trigger function and attaches it to every table — the schema declares `updated_at` trigger-maintained, and hand-written DDL does not get that for free.

Entities carry the columns and relations but are **not** the schema authority — a decorator drifting from a migration is a bug caught by `db:check` in CI, which fails the build if entity metadata and the migrated schema disagree.

### 5.2 Query timeouts, at three levels

A query with no timeout is an outage waiting for traffic.

| Level | Setting | Value |
| ----- | ------- | ----- |
| Connection | `statement_timeout` in the pool's connection options | 10 s default, from config |
| Pool | `connectionTimeoutMillis`, `idleTimeoutMillis`, `max` | 5 s / 30 s / from config |
| Query | Per-call override for known-heavy reads | Explicit, never longer than the request timeout |
| Request | Nest `TimeoutInterceptor` | 15 s, above the DB timeout so the DB error surfaces first |

The ordering is deliberate: the database must give up **before** the HTTP layer does, so the failure is a diagnosable `statement_timeout` rather than an anonymous request abort.

Pool sizing: `max` per instance × instance count must stay below Postgres `max_connections` with headroom for migrations and admin. Workers get their own smaller pool.

---

## 6. Transactions

**Every write flow runs in an explicit transaction.** Not "every write" — every *flow*: the unit of work that must be all-or-nothing.

### 6.1 One place opens transactions

```ts
// database/transaction/transaction.manager.ts
@Injectable()
export class TransactionManager {
  constructor(private readonly dataSource: DataSource) {}

  async runInTransaction<T>(
    work: (manager: EntityManager) => Promise<T>,
    options?: { isolation?: IsolationLevel },
  ): Promise<T> {
    const existing = TransactionContext.current();
    if (existing) return work(existing);              // join the ambient transaction, never nest

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction(options?.isolation ?? 'READ COMMITTED');
    try {
      const result = await TransactionContext.run(
        queryRunner.manager, () => work(queryRunner.manager),
      );
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;                                    // rethrow — never swallow
    } finally {
      await queryRunner.release();                    // always, on both paths
    }
  }
}
```

Three properties this guarantees:

- **`release()` is in `finally`**, so a connection is returned to the pool on success, on failure, and on a throw from `commit` itself. A leaked query runner exhausts the pool and takes the service down under load, which is why this is the one function nobody hand-rolls.
- **Rollback then rethrow.** The transaction manager never converts an error into a return value; the service layer decides what the failure means.
- **Nesting joins rather than nests.** `TransactionContext` is an `AsyncLocalStorage`; an inner `runInTransaction` reuses the outer manager. Savepoints are available for genuine partial rollback but are opt-in, because implicit savepoints hide bugs.

### 6.2 Rules for what goes inside

1. **No network I/O inside a transaction.** No platform API call, no HTTP request, no queue publish that isn't a row insert. A transaction holding locks while waiting on Meta is how a slow third party becomes a database incident. The pattern is: write rows *including* the `outbound_events` row, commit, and let the relay make the call — which is exactly the transactional-outbox rule from `schema.md`.
2. **Transactions are short.** Do the reads and the validation before opening one. Long transactions hold locks, block vacuum, and grow the xid horizon.
3. **Consistent lock ordering** across flows, so two concurrent operations cannot deadlock by acquiring the same rows in opposite order. Where a flow updates several tables, the order is documented in the service.
4. **Deadlocks and serialisation failures are retried**, with jitter, a small cap, and only for the Postgres error codes that mean "retryable" (`40001`, `40P01`) — never for a constraint violation.
5. **`READ COMMITTED` is the default.** `REPEATABLE READ` is used only where a flow reads a value and then writes based on it, and even then a constraint or `SELECT ... FOR UPDATE` is preferred over an isolation level, because a constraint cannot be forgotten.
6. **Idempotency is a database constraint, not a lock.** Concurrent duplicate webhooks are resolved by `ON CONFLICT` on the dedup index (`schema.md` §Idempotency), not by taking an advisory lock and checking first.

### 6.3 The service-layer shape

```ts
async replyToConversation(ctx: ActorContext, input: ReplyInput): Promise<ReplyResponse> {   // the §9 contract type
  // validation and reads happen BEFORE the transaction
  const conversation = await this.conversations.findForReply(ctx.enterpriseId, input.conversationRefId);
  if (!conversation) throw new AppException(ErrorCode.CONVERSATION_NOT_FOUND);

  const channel = await this.channels.findById(ctx.enterpriseId, conversation.channelId);
  if (channel.reauthRequired) throw new AppException(ErrorCode.CHANNEL_REAUTH_REQUIRED);

  return this.tx.runInTransaction(async () => {
    const message = await this.messages.insertOutbound({ ... });                 // status: pending
    const event   = await this.outbound.enqueue({ ... });                        // same transaction
    await this.messages.linkOutboundEvent(message.id, event.id);
    await this.conversations.touchLastMessage(conversation.id, message.createdAt);
    return { messageRefId: message.refId, status: message.status };  // 'pending'
    // no API call here — the relay sends after commit
  });
}
```

Repositories never take an `EntityManager` parameter. The base repository resolves `TransactionContext.current() ?? dataSource.manager` on every call, so the same method works inside and outside a transaction, nested services join automatically, and there is exactly **one** participation mechanism. (An explicit `manager` argument was considered and dropped: once the ambient context exists, a parallel hand-passing convention is a second way to get the same thing wrong.)

`try/catch` does **not** appear in the service for the purpose of transaction handling — the manager owns that. A service catches only when it has something specific to do: translate a driver error into a domain error, or compensate. A bare `catch` that logs and rethrows adds nothing but noise; a `catch` that swallows is a defect.

**Unique-violation translation** happens in the repository, once: Postgres `23505` on a named index becomes a typed domain error (`DUPLICATE_MESSAGE`, `IDENTIFIER_ALREADY_LINKED`) keyed off the constraint name, so callers never string-match driver output.

---

## 7. Auth

Implements the flows in `schema.md` §2, §11, §12. Three layers of guard, applied globally and opened up per route rather than the reverse — a route is protected unless it says otherwise.

### 7.1 Guard chain

```
JwtAuthGuard          → is there a valid access token?  (global, bypassed by @Public)
EnterpriseScopeGuard  → does the token carry an enterprise, and is the employment still active?
PermissionsGuard      → does @RequirePermission('conversations.reply') pass the two-gate check?
```

```ts
@Controller('conversations')
export class ConversationsController {
  @Post(':refId/reply')
  @RequirePermission(Permission.CONVERSATIONS_REPLY)
  async reply(
    @CurrentActor() actor: ActorContext,
    @Param('refId', ParseUUIDPipe) refId: string,
    @Body() body: ReplyRequest,
  ): Promise<ReplyResponse> {
    return this.service.replyToConversation(actor, { conversationRefId: refId, ...body });
  }
}
```

**`ActorContext` is the only source of identity in the application.** Built once by the guards, carried in `AsyncLocalStorage`, and never reconstructed from a request body:

```ts
export interface ActorContext {
  identityId: number;
  enterpriseId: number | null;       // null only for a staff actor who has not selected one
  employeeId: number | null;
  staffId: number | null;
  actorKind: ActorKind;              // employee | staff | system
  isImpersonated: boolean;           // staff acting inside an enterprise — audited (schema.md §25)
  permissions: ReadonlySet<string>;  // resolved once per request
  correlationId: string;
}
```

### 7.2 Permission resolution

The two-gate check from `schema.md` (§5–10) — enterprise has the feature **and** the employee's roles grant the action — is one query, in one place, `PermissionService.resolve(actor)`.

- **Resolved per request, cached per request.** Not per session: a role change must take effect on the next request, not the next login.
- **Deny by default.** No row means no permission. There are no negative grants and therefore no precedence rules to get wrong.
- **Staff bypass reaches, it does not entitle.** `staff_members.has_all_enterprise_access` grants reach into any enterprise but never bypasses the feature gate — a feature the enterprise does not have does not exist for anyone.
- A short-TTL cache (seconds) keyed on `(employeeId, rolesVersion)` is permitted later, but only with an explicit invalidation path on role change.

### 7.3 Tokens

| | Where | TTL | Notes |
| --- | --- | --- | --- |
| Access token | Response body, held in client memory | 15 min | Carries `identityId`, `enterpriseId`, `employeeId`, `actorKind` |
| Refresh token | `httpOnly` `Secure` `SameSite=Strict` cookie | 7 days | SHA-256 hash stored as a `sessions` row |

Rules: **every refresh re-checks the employment is still active**, so removing someone takes effect within the access-token lifetime; switching enterprise is a token exchange, not a re-login; logout revokes the session row and clears the cookie. Refresh-token rotation is absent by decision — recorded in `schema.md` as a known gap, since replay of a stolen token is undetectable without it. One deployment assumption to keep visible: `SameSite=Strict` only works while the web app and the API share a site — if the frontend ever moves to a different registrable domain, the cookie silently stops being sent and the setting must become `None` plus an explicit CSRF token.

Login and verification follow `schema.md` §12 exactly: normalise the credential, one index probe, one hash comparison, load employments, and issue nothing until any required verification passes. `bcrypt` is not used — **argon2id**, with parameters in config.

### 7.4 What the guards are not allowed to do

Guards authorise. They do not load business data, and they never mutate. A guard that fetches the conversation to check ownership pushes a query outside the service layer and duplicates it — ownership is checked in the service, against `enterpriseId` from the context, as part of the normal fetch.

### 7.5 Webhooks — the one deliberately public surface

Platform webhooks cannot carry our JWT, so webhook routes are `@Public` and carry a `WebhookSignatureGuard` instead: verify the platform's HMAC signature against the **raw request body**, before anything parses or persists it. Two bootstrap-level requirements follow: `NestFactory.create(AppModule, { rawBody: true })` — without it the raw bytes no longer exist after body parsing and signature verification is impossible — and an explicit body-size limit on the webhook route. A failed signature is a `401` and a log line with the source IP, never a stored event.

---

## 8. API contract — responses and errors

**Every route is versioned from day one: `/api/v1/...`** (Nest URI versioning, configured once at bootstrap). Retrofitting a version prefix later is itself a breaking change, so the version exists before the first client does. Additive changes stay in `v1`; `v2` is reserved for breaking ones.

### 8.1 One envelope, always

Every response from every endpoint has the same shape. A client never has to ask which format an endpoint uses.

```jsonc
// success
{
  "success": true,
  "data": { "messageRefId": "8f2a…", "status": "pending" },
  "meta": { "requestId": "01J…", "timestamp": "2026-08-22T10:14:03.221Z" }
}

// success, paginated
{
  "success": true,
  "data": [ { "…": "…" } ],
  "meta": {
    "requestId": "01J…",
    "timestamp": "2026-08-22T10:14:03.221Z",
    "pagination": { "limit": 50, "nextCursor": "eyJ…", "hasMore": true }
  }
}

// failure
{
  "success": false,
  "error": {
    "code": "CHANNEL_REAUTH_REQUIRED",
    "message": "This channel needs to be reconnected before you can reply.",
    "details": [ { "field": "channelRefId", "issue": "reauth_required" } ]
  },
  "meta": { "requestId": "01J…", "timestamp": "2026-08-22T10:14:03.221Z" }
}
```

`success` is redundant with the HTTP status and is kept deliberately: clients branch on one boolean instead of a status-code range, and mistakes there are a common source of bugs where a `304` or a proxy-generated `502` gets treated as success.

**RFC 9457 Problem Details** was the alternative. Rejected for consistency: it standardises the error shape but says nothing about success responses, so the API would have two unrelated envelopes. One shape for both is worth more here than conformance to a spec no client of ours will introspect.

Implemented as an interceptor (`ResponseEnvelopeInterceptor`) plus an exception filter (`AllExceptionsFilter`), so **no controller ever constructs an envelope by hand**. Controllers return plain data; the interceptor wraps.

### 8.2 Error codes are an enum, not strings

```ts
export enum ErrorCode {
  // auth
  AUTH_INVALID_CREDENTIALS   = 'AUTH_INVALID_CREDENTIALS',
  AUTH_CODE_EXPIRED          = 'AUTH_CODE_EXPIRED',
  AUTH_CODE_ATTEMPTS_EXCEEDED= 'AUTH_CODE_ATTEMPTS_EXCEEDED',
  AUTH_NO_ACTIVE_MEMBERSHIP  = 'AUTH_NO_ACTIVE_MEMBERSHIP',
  // authorisation
  PERMISSION_DENIED          = 'PERMISSION_DENIED',
  FEATURE_NOT_ENABLED        = 'FEATURE_NOT_ENABLED',
  // validation
  VALIDATION_FAILED          = 'VALIDATION_FAILED',
  // domain
  CHANNEL_REAUTH_REQUIRED    = 'CHANNEL_REAUTH_REQUIRED',
  CONVERSATION_NOT_FOUND     = 'CONVERSATION_NOT_FOUND',
  IDENTIFIER_ALREADY_LINKED  = 'IDENTIFIER_ALREADY_LINKED',
  // infrastructure
  RATE_LIMITED               = 'RATE_LIMITED',
  UPSTREAM_UNAVAILABLE       = 'UPSTREAM_UNAVAILABLE',
  INTERNAL_ERROR             = 'INTERNAL_ERROR',
}
```

Each code maps to exactly one HTTP status in a single table, so a status is never chosen ad hoc at a throw site:

| Code family | Status |
| ----------- | ------ |
| `VALIDATION_FAILED` | 422 |
| `AUTH_*` (credentials, codes, expiry) | 401 |
| `AUTH_NO_ACTIVE_MEMBERSHIP` — authenticated, but no active business | 403 |
| `PERMISSION_DENIED`, `FEATURE_NOT_ENABLED` | 403 |
| `*_NOT_FOUND` | 404 |
| `*_ALREADY_*`, conflicts | 409 |
| `RATE_LIMITED` | 429 |
| `UPSTREAM_UNAVAILABLE` | 502 / 503 |
| `INTERNAL_ERROR` | 500 |

Verification-required on login is **not an error**: per `schema.md` §12, `POST /auth/login` returns `200` with `{ verificationRefId, deliveryChannel, maskedDestination }` in the success envelope when verification is needed. The `AUTH_*` 401 codes cover failed credentials and failed/expired codes only.

Services throw one exception type:

```ts
throw new AppException(ErrorCode.CHANNEL_REAUTH_REQUIRED, {
  details: [{ field: 'channelRefId', issue: 'reauth_required' }],
});
```

**The filter never leaks internals.** A `500` returns `INTERNAL_ERROR` with a generic message and the `requestId`; the stack, the driver error, and the SQL go to the log under that same `requestId`. No stack traces, no constraint names, no internal ids in a response body.

Adding an error code is a **backward-compatible** change; changing or removing one is breaking, and the codes are documented as part of the public contract.

### 8.3 Pagination, filtering, sorting

- **Cursor-based** for every list that can grow — conversations, messages, customers, posts. Offset pagination is only permitted for bounded admin lists.
- `limit` is validated and **capped** (default 50, max 200). An unbounded list endpoint is a denial-of-service primitive.
- The cursor is opaque, base64, and contains the sort key **plus `id`** as a tiebreaker — matching the composite indexes in `schema.md`, so pagination is deterministic and cannot skip or repeat rows.
- Sort and filter fields come from a **per-endpoint allowlist**, never from raw user input mapped into SQL.

---

## 9. Contracts and types

Requirement 10 — "response/request types stored for easy reference" — is solved by making the schema the type.

```ts
// shared/contracts/conversations/reply.contract.ts
export const ReplyRequestSchema = z.object({
  body:           z.string().trim().min(1).max(5000),
  attachmentIds:  z.array(z.string().uuid()).max(10).optional(),
  idempotencyKey: z.string().min(8).max(64),      // schema.md §21
}).strict();                                       // unknown keys are rejected, not ignored

export const ReplyResponseSchema = z.object({
  messageRefId: z.string().uuid(),
  status:       z.nativeEnum(MessageStatus),
});

export type ReplyRequest  = z.infer<typeof ReplyRequestSchema>;
export type ReplyResponse = z.infer<typeof ReplyResponseSchema>;
```

One declaration produces the runtime validator, the TypeScript type, and the OpenAPI schema. `.strict()` everywhere: an unexpected field is a client bug and silently dropping it hides it.

`idempotencyKey` lives in the request **body** rather than an `Idempotency-Key` header, deliberately: it stays inside the same typed contract, is validated by the same schema, and appears in Swagger without a custom decorator. The guarantee is the database unique index either way.

**The contract layer is the reference.** `shared/contracts/` is organised by module and is the one place to look for what an endpoint accepts and returns. Two things keep it honest:

1. **The OpenAPI document is generated and committed** to `docs/openapi.json` by a CI step. A PR that changes an endpoint shows the contract diff in review, and an accidental breaking change is visible rather than discovered by a client.
2. **A breaking-change check** compares the generated spec against the previous one and fails the build on a removed field, a narrowed type, or a new required request field.

Response mapping is explicit — an entity is never returned directly. A mapper per resource converts entity → response, which is what keeps `id`, `password_hash`, and the encrypted `access_token` columns from ever reaching a client by accident.

---

## 10. Swagger

`@nestjs/swagger`, served at `/docs` in dev and qa, and **disabled in prod** unless behind staff auth.

```ts
const config = new DocumentBuilder()
  .setTitle('Wouchh Unified API')
  .setDescription('Social inbox, comments and posts for connected enterprises.')
  .setVersion(configService.get('APP_VERSION'))   // process.env is read only in config/ (§4.2)
  .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'accessToken')
  .addCookieAuth('refreshToken')
  .addTag('auth').addTag('conversations').addTag('customers').addTag('channels')
  .build();
```

What "proper examples" means here, concretely:

- **Every endpoint documents at least one realistic success example and its likely failures**, using `@ApiResponse` with named examples — not just a schema. A reader should be able to copy a body and have it work.
- Examples are **derived from the Zod schemas** via `zod-to-openapi`, so an example that no longer validates fails CI.
- Error responses are documented **per endpoint with actual error codes** — `@ApiErrorResponses(ErrorCode.CHANNEL_REAUTH_REQUIRED, ErrorCode.PERMISSION_DENIED)` — so the client author learns the codes from the docs rather than by triggering them.
- The envelope is applied in the docs too, via a generic `ApiEnvelope(Model)` helper, so documented shapes match what the interceptor actually returns.
- Enum parameters render their **full value list**, sourced from the shared enums (§11) so docs cannot drift from code.
- `operationId` is stable and explicit, so generated clients have sane method names.

---

## 11. Enums and constants — nothing hardcoded

`schema.md` decided that enum values are validated in application code rather than by database `CHECK` constraints. That makes the code the single authority, so it has to be organised like one.

```
shared/enums/
  actor.enum.ts           ActorKind, EmployeeKind
  identity.enum.ts        IdentityStatus, EmployeeStatus, StaffStatus, EnterpriseStatus, RoleScope
  auth.enum.ts            VerificationKind, DeliveryChannel, DeliveryStatus, VerificationMethod
  connection.enum.ts      Provider, ProviderCategory, Platform, ChannelKind, TokenStatus,
                          ConnectionStatus, ChannelStatus
  sync.enum.ts            SyncJobKind, SyncTriggerKind, SyncJobStatus
  customer.enum.ts        IdentifierKind, IdentifierStatus, IdentifierSource, VerificationStatus,
                          CustomerStatus, CustomerFirstSource
  conversation.enum.ts    ConversationKind, ConversationStatus, MessageDirection, MessageKind,
                          MessageStatus, PostKind, PostStatus
  attachment.enum.ts      MediaKind, AttachmentStatus
  ledger.enum.ts          InboundEventStatus, OutboundEventStatus, EventType, SourceKind,
                          DestinationKind, EventPriority (the numeric map — schema.md §23)
  audit.enum.ts           AuditAction, AuditEntityType, AuditStatus
  feature.enum.ts         FeatureKey, FeatureStatus, EnterpriseFeatureStatus
  permission.enum.ts      Permission (the codes), PermissionResource, PermissionAction
```

Rules:

1. **A string literal that represents a domain value is a lint error.** `'instagram'`, `'active'`, `'comment_thread'` appear in exactly one file each. Enforced with `no-magic-strings`-style rules plus review.
2. **Enum values are the exact strings stored in the database**, lower `snake_case`, so there is no mapping layer to get wrong.
3. **Zod derives from the enum**: `z.nativeEnum(Platform)`. One declaration validates the API, types the code, and documents itself in Swagger.
4. **Unknown-value detection is a scheduled sweep, not a boot check.** Scanning every enum column at boot would be a full scan of the largest tables on every deploy — an outage-shaped startup step. Instead a nightly sweeper (§12) samples recent rows for enum values the code does not know and alerts, and entity transformers log an unknown value whenever one is read. Without `CHECK` constraints this is the safety net that catches a bad write path or a stale deploy.
5. **Numbers that are code invariants live in `shared/constants/`**, named and typed — `MAX_PAGE_SIZE`, `SYNC_PAGE_SIZE`. A literal `50` or `10000` in a service is a defect. Durations like OTP expiry and lease length are **not** constants — they are config per rule 6 (`WORKER_LEASE_SECONDS` in §4.2; per-kind verification parameters per schema.md §12, which says they are "all configuration, none hardcoded").
6. **Anything environment-dependent is config, not a constant** — timeouts, retry counts, warning windows, cooldowns, rate limits, pool sizes, feature-flag defaults. The rule of thumb: if QA might want a different value, it is config.

Config, constants and enums are three distinct things and the boundary matters: **enums** are domain vocabulary, **constants** are invariants of the code, **config** is anything an environment can change.

---

## 12. Background work — Postgres only, by decision

The HTTP API never does slow work inline. **There is no Redis in V1.** The ledger tables are the queue and workers poll them — which was already this design's stance ("the database row is authoritative; the queue is only a trigger"). Removing the trigger costs wake-up latency measured in seconds, not correctness, and removes an entire infrastructure dependency.

| Worker | Claims from | Does |
| ------ | ----- | ---- |
| **Inbound projector** | `inbound_events` claimable index | Projects ledger rows into customers / conversations / messages |
| **Outbound relay** | `outbound_events` due index | Calls the platform, writes back `platform_event_id` and status |
| **Sync runner** | `sync_jobs` runnable index | Walks platform history with cursors, honours rate limits |
| **Attachment downloader** | `message_attachments` pending index | Copies expiring platform CDN media into our object storage |
| **Sweepers** | scheduled | Token expiry, verification cleanup, lease reclaim, unknown-enum sweep (§11), dead-letter alerts |

### The claim loop

Every worker is the same shape: an interval loop (`@nestjs/schedule`) that claims a batch in one statement and processes outside the claim transaction.

```sql
-- one atomic claim; no two workers ever hold the same row, and neither waits
UPDATE inbound_events
SET    status = 'leased', lease_owner = $1, lease_expires_at = now() + $2 * interval '1 second'
WHERE  id IN (
  SELECT id FROM inbound_events
  WHERE  status IN ('pending','failed') AND COALESCE(next_attempt_at, created_at) <= now()
  ORDER  BY priority, COALESCE(next_attempt_at, created_at), id
  LIMIT  $3
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

Rules, all traceable to `schema.md`:

- **Poll interval, batch size, and lease duration are config** (`WORKER_POLL_INTERVAL_MS`, `WORKER_BATCH_SIZE`, `WORKER_LEASE_SECONDS`). An idle poll is one cheap probe against a partial index that contains only claimable rows — the indexes exist precisely so an empty poll never touches processed rows. Idle workers back off to a longer interval and snap back on the first hit.
- **Claim in one statement.** The `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` shape is the whole concurrency story: no advisory locks, no check-then-set race.
- **Leases are always bounded.** A reaper sweep returns expired leases to `pending`; a worker that dies mid-batch loses its lease, not the work.
- **Every external call has a timeout, capped retries, exponential backoff with jitter, and a terminal dead-letter state** — all recorded on the row (`attempt_count`, `next_attempt_at`, `dead_lettered_at`), because the row is the source of truth.
- **Fail fast on a dead token** — check `reauth_required` before a send rather than burning attempts.
- **Ambiguous sends read back before retrying** (`schema.md`, case 5).
- **Concurrency is per platform**, so one enterprise's backlog cannot consume the rate budget of another.
- **Graceful shutdown**: stop claiming, finish or release in-flight rows, then exit. Nest's `enableShutdownHooks` plus a `SIGTERM` handler; the container's termination grace period exceeds the longest job.

### What polling costs, and when a queue comes back

Worst-case pickup latency is one poll interval — seconds, tunable per worker. At V1 volume that is invisible, and the failure story is strictly better than a broker's: there is no second system whose loss loses jobs.

When sub-second dispatch or cross-instance coordination is genuinely needed, add a wake-up signal — Postgres `LISTEN/NOTIFY` first, a real broker later — **as a trigger only**. The claim loop and the DB-authoritative rows do not change, which is what makes that upgrade additive rather than a migration.

---

## 13. Health, observability, resilience

### 13.1 Health endpoints

Three, because Kubernetes asks three different questions. Built on `@nestjs/terminus`.

| Endpoint | Question | Checks | Fails when |
| -------- | -------- | ------ | ---------- |
| `GET /health/live` | Is the process alive? | Nothing external | Event loop wedged / process broken |
| `GET /health/ready` | Should it receive traffic? | DB `SELECT 1`, migrations applied | The database is unreachable — instance is pulled from the load balancer |
| `GET /health/startup` | Has it finished booting? | Config valid, migrations applied, pool warm | Still starting — stops premature liveness kills |

Rules: **`/live` never touches the database.** A slow query must not restart the process — that is how a database hiccup becomes a cascading restart loop. `/ready` failing sheds traffic; `/live` failing kills the pod, and those must not be conflated. Health output contains no version details, no hostnames, no dependency URLs — it is unauthenticated. A separate authenticated `GET /health/detail` carries the diagnostic breakdown.

### 13.2 Logging

**pino**, JSON, one line per event. Every log line carries `correlationId`, and where known `enterpriseId`, `actorKind`, `route`.

- **`correlationId`** is taken from an inbound header if present, otherwise generated, and stored in `AsyncLocalStorage` so no function has to thread it. It flows into `inbound_events.correlation_id` / `outbound_events.correlation_id`, so a support question traces from an HTTP request through the ledger to a platform call.
- **Redaction is a pino allowlist, not a denylist.** Fields are redacted by default; specific safe fields are opted in. A denylist misses the next field someone adds. Never logged, under any circumstance: passwords, password hashes, access tokens, refresh tokens, verification secrets, and — from `schema.md` — the ledger `payload`, customer `display_name`/`username`, emails, and phone numbers. Where an identifier must appear, it is hashed or masked (`+9198***3210`).
- **Request/response body logging is off in prod**, sampled and redacted in qa.
- Log levels mean something: `error` is actionable, `warn` is a degraded-but-handled condition, `info` is lifecycle, `debug` is off in prod. No `info` logging inside a per-row loop.

### 13.3 Metrics and tracing

Prometheus metrics on an internal port, and OpenTelemetry traces.

Minimum viable set: HTTP request rate / error rate / latency histogram by route; DB pool in-use and wait time; slow-query count; **ledger lag** (`received_at` → `processed_at`), claim rate, attempt counts, dead-letter counts; claimable-backlog depth **and** age of the oldest claimable row; platform API call latency, error rate, and rate-limit hits per provider; verification issue/verify/fail rates.

**Backlog depth without lag is a misleading metric** — a backlog that is draining slowly looks healthy by depth alone. Alerting is on lag and dead-letter growth.

### 13.4 Resilience

- Every outbound HTTP call: **timeout, capped retries with jittered backoff, and a circuit breaker per provider.** A provider outage degrades one feature; it does not exhaust the pool or the event loop.
- **Rate limiting** at the edge with `@nestjs/throttler`, in-memory per instance. Accepted while there is no Redis and the instance count is small — and the security-critical throttles are already **global by construction**, because they live in Postgres: `identities.failed_login_count` / `locked_until` for login, and the `verifications` destination index for send caps (`schema.md` §12). Tighter buckets on `/auth/*` and verification sends, keyed on the normalised credential and the source IP. Revisit the edge limiter when instances multiply.
- **Idempotent mutations.** Anything that creates, sends, or pays accepts an `idempotencyKey` and is safe to retry — backed by the unique indexes in `schema.md`, not by an in-memory cache.
- **Backpressure**: bounded queues and explicit `503` with `Retry-After` rather than unbounded accept.
- **Payload limits** on every endpoint; no unbounded body, no unbounded array.

---

## 14. Docker and deployment

Multi-stage build, non-root, no toolchain in the final image.

```dockerfile
# ---- deps ----
FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml .npmrc ./
# ignore-scripts is the mitigation for the 2026 install-hook attacks (§2)
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build && pnpm prune --prod --ignore-scripts

# ---- runtime ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=prod
RUN addgroup -S app && adduser -S app -G app && apk add --no-cache tini
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./
USER app
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
```

Points that matter:

- **`tini` as PID 1**, so `SIGTERM` actually reaches Node and graceful shutdown runs. Without an init, signals are swallowed and the container is killed mid-request.
- **Non-root user, read-only root filesystem** at runtime (writable `/tmp` only), no shell in the final layer where practical.
- **`--ignore-scripts` on every install**, per §2.
- **The image contains no secrets and no `.env` file.** Configuration arrives as environment variables at run time.
- **Same image for API and workers**, different `CMD`. One artifact, one digest, no drift between what was tested and what runs.
- **No `HEALTHCHECK` in the image** — the orchestrator owns liveness and readiness, and duplicating it in Docker means two definitions to keep in sync.
- Image is scanned (Trivy or equivalent) as a blocking CI step, and tagged by immutable digest in deployment manifests rather than by a mutable tag.

**Deploy order**, always: run migrations → deploy code. Migrations are backward compatible (expand/contract), so the previous version keeps working during a rolling deploy and a rollback does not need a down-migration. Migrations run as a separate job, never on application boot — otherwise N instances race to migrate.

`docker-compose.yml` for local: Postgres (with `pg_trgm` available), the API, and a worker — so a developer gets the whole system with one command. A debug override (`docker-compose.debug.yml`) runs the API with `node --inspect=0.0.0.0:9229 dist/main.js` and maps `9229:9229` — that is what §4.3's "Attach to running container" configuration connects to. The inspector is never enabled in production.

---

## 15. Security checklist

Beyond auth (§7) and supply chain (§2):

- **Helmet**, strict CORS allowlist (no wildcard with credentials), and `trust proxy` set correctly so rate limiting sees the real client IP.
- **Tenant scoping is structural.** `enterpriseId` comes from the token; every tenant-scoped repository method requires it; the composite foreign keys from `schema.md` make a cross-tenant write unrepresentable. Postgres RLS is recommended as a second layer on the customer tables — deferred, with the pooler interaction to resolve.
- **Parameterised queries only.** No string interpolation into SQL, anywhere, including the raw escape hatch.
- **Secrets from a secret manager.** The token-encryption key (`schema.md` §14) and the verification HMAC pepper (§12) are never in the repo, an env file, or an image layer.
- **Webhook signature verification** on every inbound platform request, before the payload is parsed, using the raw body.
- **No sensitive data in URLs** — no tokens, no codes, no identifiers in query strings, since those land in access logs.
- **Audit the sensitive actions**, per `schema.md` §25, including `is_impersonated` when Wouchh staff act inside an enterprise.
- **Dependency and image scanning** blocking in CI; `pnpm audit` on a schedule as well as on PR.

---

## 16. Testing

| Layer | Tool | Scope |
| ----- | ---- | ----- |
| Unit | Vitest | Services with repositories mocked. Business rules, state machines, permission resolution |
| Integration | Vitest + Testcontainers | Repositories against **real Postgres** — the only way to test partial unique indexes, `ON CONFLICT`, and composite FKs |
| E2E | Vitest + supertest | Auth flows, envelope shape, guard behaviour, pagination |
| Contract | generated OpenAPI diff | Breaking-change detection |

Non-negotiables: **integration tests run against real Postgres**, because every interesting constraint in this schema is a Postgres feature a mock cannot reproduce — a mocked repository would happily accept the duplicate that the real partial unique index rejects. Tests are **deterministic**: time is injected, not read from the clock; randomness is seeded; no test depends on another's leftovers. Every flow has a **negative** test — invalid input, expired token, exhausted attempts, cross-tenant access attempt, duplicate webhook. The cross-tenant test is mandatory for every tenant-scoped endpoint: authenticate as enterprise A, request enterprise B's resource by `refId`, assert 404.

Vitest rather than Jest (the Nest 11 default) is deliberate: v12's toolchain swap adopts Vitest, so choosing it now removes one of the four migration axes (§1.1).

CI gates: type-check, lint, format, unit, integration, `db:check` schema drift, OpenAPI breaking-change check, dependency audit, image scan.

---

## 17. Decisions still open

1. **NestJS 12 upgrade window** — revisit in roughly a quarter, once the migration guide is published and `@nestjs/typeorm`, `@nestjs/swagger`, and `@nestjs/terminus` have shipped v12-compatible releases.
2. **`synchronize`** — **settled: `false` in every environment**, with `db:reset` giving the same iteration speed (§5.1). Enabling it would silently `DROP` the partial/expression indexes and composite FKs the schema's tenant isolation and idempotency depend on.
3. **Zod vs class-validator** — Zod recommended (§1.3). Reversible per endpoint.
4. **Secret manager choice** — determines how the encryption key and HMAC pepper are loaded, and how rotation runs.
5. **Postgres RLS** — recommended for the customer tables; needs a decision on how `app.enterprise_id` is set per connection, which depends on the pooler (PgBouncer transaction pooling interacts badly with session-level `SET`).
6. **Deployment target** — Kubernetes vs ECS vs a PaaS changes the health-probe wiring, secret injection, and the migration job, though not the application.
7. **Read replicas** — not needed at launch; the repository layer is the place to add a read/write split when it is, so the decision does not leak into services.
8. **When a queue/Redis comes back** — the trigger is sub-second dispatch, cross-instance rate limiting, or scheduled fan-out beyond polling. Added as a wake-up signal only (§12); the DB-authoritative rows make it additive.

---

## 18. Meta connection flow

Ported from the **working socialLift implementation** — a production codebase making real Graph API calls. The wire traffic to Meta below is byte-for-byte the shape of that proven code; what changes is only the packaging around it (where tokens live, CSRF, error surfacing). Do not "improve" the Graph mechanics — they encode lessons that only show up against the real API.

### 18.1 The flow

```
GET /api/v1/connections/meta/connect                 (authenticated, RequirePermission channels.connect)
  ├─ build state: HMAC-signed payload { enterpriseId, employeeId, nonce, exp: now()+10min }
  └─ 302 → https://www.facebook.com/{GRAPH_API_VERSION}/dialog/oauth
             ?client_id={FB_APP_ID}
             &redirect_uri={META_OAUTH_REDIRECT_URI}       ← one static URI, identical in the exchange
             &config_id={FB_LOGIN_CONFIG_ID}               ← Facebook Login for Business:
             &response_type=code                              permissions come from the dashboard
             &state={signed state}                            configuration, there is NO scope param

GET /api/v1/connections/meta/callback?code&state     (@Public — the browser arrives unauthenticated)
  ├─ verify state signature + expiry + single-use; reject on any failure     ← the socialLift demo
  │                                                                             skipped this; we do not
  ├─ error / error_description present → redirect to FRONTEND_DASHBOARD_URL?status=error&reason=denied
  ├─ code → short-lived token:
  │    GET graph.facebook.com/{v}/oauth/access_token?client_id&client_secret&redirect_uri&code
  ├─ short → long-lived token:
  │    GET graph.facebook.com/{v}/oauth/access_token?grant_type=fb_exchange_token
  │        &client_id&client_secret&fb_exchange_token={short}
  │    → capture expires_in → provider_connections.token_expires_at            ← socialLift discarded
  │                                                                              this; we track expiry
  ├─ GET /me → provider_user_id (+ name)
  ├─ discover pages, primary path — ONE call with field expansion:
  │    GET /me/accounts?fields=id,name,access_token,category,instagram_business_account{id,username}
  ├─ zero pages → the debug_token fallback (New Page Experience / business portfolios):
  │    GET /debug_token?input_token={longLived}&access_token={FB_APP_ID}|{FB_APP_SECRET}
  │    → data.granular_scopes → target_ids from the first of pages_show_list /
  │      pages_messaging / pages_read_engagement that has any
  │    → per id: GET /{page_id}?fields=access_token,name,instagram_business_account{id,username}
  ├─ persist, one transaction:
  │    ├─ UPSERT provider_connections (enterprise_id, provider='meta', provider_user_id)
  │    │    access_token = encrypted long-lived user token (§14 envelope), token_expires_at,
  │    │    granted_scopes, connected_by_employee_id, status='active', reauth_required=false
  │    ├─ per page:  UPSERT channels (platform='facebook',  channel_kind='page',
  │    │    platform_channel_id=page_id, access_token=encrypted page token)
  │    ├─ per linked IG account: UPSERT channels (platform='instagram', channel_kind='profile',
  │    │    platform_channel_id=ig id, parent_channel_id=the page's channel,
  │    │    token_status='not_applicable' — IG calls authorise with the parent Page token)
  │    └─ INSERT sync_jobs (trigger_kind='initial_connect'): backfill_posts,
  │         backfill_comments, backfill_conversations per channel
  ├─ per page: POST /{page_id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,feed,mention
  │    with the PAGE token. A failure marks that channel status='error' — recorded, not swallowed
  └─ 302 → FRONTEND_DASHBOARD_URL?status=success&connectionRefId={ref_id}&pageCount={n}
       ← refIds and counts only. No token of any kind ever appears in a URL
```

**Every Graph call carries `appsecret_proof`** = `HMAC-SHA256(FB_APP_SECRET, access_token)` hex — exactly as the working code does (`graph.js`). POST parameters go in the request body, not the query string.

### 18.2 Webhooks

```
GET  /api/v1/webhooks/meta      hub.mode=subscribe + hub.verify_token === META_WEBHOOK_VERIFY_TOKEN
                                → 200 text/plain hub.challenge; anything else → 403
POST /api/v1/webhooks/meta      1. x-hub-signature-256 required; sha256 prefix; HMAC-SHA256 of the
                                   RAW body under FB_APP_SECRET; crypto.timingSafeEqual after a
                                   length guard (ported verbatim from webhooks.js:36-66) — else 401
                                2. explode body.entry[] → one inbound_events row each, dedup_key per
                                   schema.md; duplicate = ON CONFLICT DO NOTHING, still 200
                                3. always 200 fast — projection happens in the worker, never inline
```

The route is registered with the raw-body parser **before** the JSON parser (§7.5) — the one middleware-ordering rule socialLift's `AGENTS.md` calls out as its main gotcha, preserved here.

### 18.3 Errors and token death

- **The 24-hour messaging window** (proven mapping from `messages.js:88-101`): Graph error `subcode 2534022`, `code 10`, or an "allowed window" message → `ErrorCode.MESSAGING_WINDOW_CLOSED`, HTTP 409. Documented per endpoint in Swagger.
- **A live auth error beats the calendar** (schema.md §14): any Graph `OAuthException` code `190` (subcodes `463` expired / `467` invalidated) marks the connection `revoked` + `reauth_required = true` immediately and cascades to child channels. The expiry sweep handles the calendar case.
- **Partial failures are surfaced, never swallowed**: a page whose detail call fails is persisted with what was available and reported in the redirect (`pageCount` vs `errorCount`); socialLift's behaviour of redirecting `status=success` with an empty pages array is explicitly not ported.

### 18.4 What deliberately differs from socialLift, and why

| socialLift (demo-grade) | Here | Why |
| --- | --- | --- |
| `state` = raw client-supplied user id, never validated | HMAC-signed `{enterpriseId, employeeId, nonce, exp}`, single-use | Their git history had real CSRF state and removed it for demo convenience (`b290456`); this is login CSRF |
| Page tokens sent to the browser in URLs, AES-CBC without a MAC | Tokens never leave the server; AES-256-GCM envelope in Postgres (§14) | URLs land in history, Referer, and proxy logs; CBC without a MAC is malleable |
| `expires_in` discarded, no expiry tracking, no re-auth path | `token_expires_at` captured; sweep + `reauth_required` per schema.md §14 | Their only recovery from a dead token was the user noticing 500s |
| Per-page N+1 detail calls | One `/me/accounts` call with field expansion; per-page calls only in the `debug_token` fallback | Same data, one round trip; the fallback keeps the per-page shape because that path has no `/me/accounts` response to expand |
| Cleartext token logging | §13.2 redaction allowlist; tokens never logged | Non-negotiable |
| CORS `*` | Strict allowlist (§15) | The env var existed in their config and was ignored |

None of these change a single request to Facebook.

---

## 19. What implementation changed

The design above was written before the code. Building it surfaced facts that no
amount of design review would have produced, so they are recorded here rather
than left as a difference between the document and the repository.

### 19.1 Corrections to §1 and §5 — the toolchain

**tsx cannot run this application.** It transpiles with esbuild, which does not
emit `emitDecoratorMetadata`, so `design:paramtypes` is absent and EVERY
type-reflected injection resolves to `undefined`. The symptom is misleading:
providers that use an explicit token (`@InjectDataSource`, `@InjectPinoLogger`)
resolve fine, so the failure looks like a module-wiring problem. The application
builds and runs on **SWC** with `decoratorMetadata: true` (`.swcrc`); tsx remains
fine for the scripts, which use no DI.

**TypeORM's result shapes are not uniform.** Verified against Postgres 18:

| Statement | Returns |
| --------- | ------- |
| `SELECT` | `[{...}, {...}]` — flat rows |
| `INSERT ... RETURNING` | `[{...}]` — flat rows |
| `UPDATE`/`DELETE ... RETURNING` | `[[{...}], 1]` — `[rows, affectedCount]` |

Reading `rows[0]` on the tuple silently yields the inner ARRAY and `rows.length`
silently yields 2, so "did this update match?" written as `rows.length === 1` is
always false. `BaseRepository.mutate()` normalises it in one place — the concrete
payoff of §5's one-mechanism rule, since the trap is disarmed everywhere at once.

**A generated `BIGINT` id hydrates as a string.** The driver-level `int8` parser
covers rows read back, but TypeORM builds a freshly-inserted entity from its own
`RETURNING` handling, so an id could be a string on the object that just came
from `save()` and a number on the same row loaded later. The primary key is
therefore `@PrimaryColumn` + `@Generated('increment')` with the bigint
transformer, because `@PrimaryGeneratedColumn`'s typed options reject a
transformer.

**Entity and migration globs are replaced by explicit lists.** TypeORM resolves a
glob at runtime and `require`s the matches itself, bypassing the build's
transform: under the test runner it tried to execute raw TypeScript.

**No global `ValidationPipe`.** Nest's pipe requires `class-validator`, which
§1.3 deliberately does not use. Each handler parses its request with its Zod
schema.

**`app.use(json())` breaks webhook signature verification.** The `rawBody: true`
option is implemented inside Nest's own body parsers, so replacing them with
express middleware silently discards `req.rawBody` — and the HMAC then has
nothing to verify against. Use `app.useBodyParser(...)`.

### 19.2 Correction to §8.2 — errors the filter did not own

Body-parser failures (413, 415, aborted requests) are `http-errors` instances,
not Nest `HttpException`s, and carry no `code`. They fell through to
`INTERNAL_ERROR`, so a client sending too large a body was told the server had
failed. The filter now recognises anything carrying an HTTP-range `status`, and
trusts the library's `expose` flag to decide whether its message is client-safe.

### 19.3 Correction to §13.1 — a probe must answer in its status code

`/health/ready` and `/health/startup` reported failure only in the JSON body. An
orchestrator reads the STATUS CODE, so a degraded instance was never pulled from
the load balancer. Both now return `503` when a check fails.

### 19.4 Correction to §12 — leases need fencing, not just bounding

A bounded lease is not enough. With the documented defaults — batch 20, 10 s per
platform call, a 120 s lease — a batch can run for 200 s, the reaper re-queues
the row, and a second worker sends the same message. Two changes: the lease is
re-checked immediately before each send, and the write-back is conditional on
`lease_owner`, so a worker that lost its claim cannot settle the row.

Also: `RETURNING` has no defined row order, so the claim's `ORDER BY` decides
WHICH rows are taken but not the order they come back in. Priority is re-applied
in code, or an urgent event inside a batch runs after a low-priority one.

### 19.5 Correction to §18 — one Page, several tenants

`channels_platform_uniq` is `(platform, platform_channel_id,
provider_connection_id)` with no enterprise component, precisely so an agency and
the brand it manages can both connect the same Page. Resolving an inbound webhook
with `LIMIT 1` therefore delivered the event to one of them and silently dropped
the rest. Attribution now fans out to every channel holding that platform id,
each with its own enterprise-scoped dedup key.

A dedup key composed from an object id alone is also not enough for a Facebook
`feed` change: one comment id carries several distinct events over its life
(added, edited, hidden, removed), so the verb belongs in the key or every event
after the first is discarded as a duplicate.

### 19.6 The tenant-safety gap composite foreign keys do not close

Composite FKs make a cross-tenant REFERENCE unrepresentable. They do nothing for
an UPDATE of ordinary columns: `UPDATE provider_connections SET reauth_required
= true WHERE id = $1` is well-formed whoever owns row `$1`. One such write
existed, and it was reachable — a dead token on one tenant's channel revoked
another tenant's connection, because a `channels.id` was passed where a
`provider_connections.id` was expected and both are `BIGSERIAL` typed `number`.

The rule this produces, now applied throughout: **every tenant-scoped write names
`enterprise_id` in its `WHERE` clause**, even when the primary key alone would
identify the row. The composite keys protect the shape of the data; only the
predicate protects the write.

### 19.7 Phase 1 — what the login, signup and admin work changed

Built after §1–§18 were written, so these supersede them where they differ. The
flow-level account of all of it is [`backend-flows.md`](backend-flows.md).

- **A business is not usable when it signs up.** `EnterpriseStatus` gained
  `pending_activation`, and signup lands there rather than in `active`. A new
  per-request guard refuses tenant-scoped routes for a business that is not
  `active`, with `ENTERPRISE_PENDING_ACTIVATION` or `ENTERPRISE_SUSPENDED` — a
  precise reason rather than a bare permission denial. Staff are exempt, because
  somebody has to be able to look at a business to decide whether to activate it.
- **Employment resolution no longer filters on the business's status.** It used to,
  which made a suspended business's employment vanish and surfaced to its owner as
  "this account has no active business". Whether someone is a employee and whether
  the business may be used are two questions, and only the second one has an
  answer worth showing a person.
- **A verification challenge is driven by proof, not by login count.** It used to
  fire on any first login. It now fires when the credential being used has not been
  proven — identical for a real signup, because signup leaves both credentials
  unverified, but it lets an account provisioned from configuration sign straight
  in instead of being locked out of its own first login.
- **Login stopped enforcing the password strength policy.** Strength is checked
  where a password is chosen. At login it leaked the policy for free and locked out
  any account whose password predated it.
- **Access tokens now carry a `typ` claim, and their shape is validated.** Both
  token kinds are signed with the same secret, so a selection token verified
  perfectly as an access token; it carries none of the actor claims, and because an
  absent claim is not `null`, the resulting context slipped past the guard that
  exists to reject a token with no enterprise.
- **`isImpersonated` now requires an enterprise.** A platform admin with no tenant
  scope was being marked as impersonating, which would have put
  `is_impersonated = true` on every platform audit row and destroyed the only
  signal the flag exists to give.
- **`/auth/me` no longer returns internal ids,** and now reports whether the caller
  is an internal admin and what state their business is in — what a client needs
  after a page reload, when all it holds is a token.
- **Verification delivery goes through a communication module** with one switch,
  `OTP_REALTIME_ENABLED`. Off, nothing is sent and every numeric code is the fixed
  `OTP_STATIC_CODE`; production refuses to boot in that state. Link tokens stay
  random regardless. The provider behind it is a mock, bound in one place.
- **The audit write path exists and is used** by the platform console — the first
  code anywhere to write `audit_logs`.
- **A platform console and an internal-staff axis.** `@RequirePlatformAdmin` is
  deliberately not a permission: permissions live inside an enterprise and are
  gated by what it has bought, which is the wrong shape for "this person works for
  us", and keeping it separate means no role edit can ever grant platform reach.
  The one admin is provisioned from configuration, because there is no staff signup
  and there should never be one.
- **Cross-tenant reads live in one named file.** Every query that deliberately
  spans tenants is in `platform-admin.repository.ts` and reachable only behind the
  platform gate, so a reviewer can find all of them by opening one file.

### 19.8 Phase 2 — employees, and the one-signup-per-business rule

- **`members` became `employees` everywhere** — tables, columns, enums, permission
  codes, error codes, the token claim, both design docs. `enterprise_members` is
  now `enterprise_employees`, `member_roles` is `employee_roles`, and every
  `*_member_id` is `*_employee_id`. `staff_members` deliberately did NOT change:
  Wouchh's own people are a different concept, and blurring the two would be worst
  exactly where it matters, in the audit trail.
- **`employee_kind` says `business` or `support`,** not `enterprise` or `staff`.
  One table still holds both populations, because they need the same roles, the
  same assignment and the same audit trail — but calling an embedded Wouchh
  person an employee of the customer's business would be a lie, and `support`
  reads correctly in an audit row. (I had proposed `internal`; it is ambiguous
  about internal to WHOM, which is the opposite of what the value means.)
- **A business can be signed up exactly once.** `enterprises.email` is unique on
  `lower(email)` among live rows. Without it two colleagues each signing up "Acme
  Coffee" got two tenants and a `-2` slug: split data and a product that looks
  broken rather than duplicated.
- **Employees are created, never self-registered.** `POST /employees` takes a
  name, an address and a role — and refuses a password. The identity is created
  with a random one nobody is told; the only way in is the invitation.
- **An invitation is a CODE keyed on the destination,** which looks like it
  contradicts §12's "a long-lived secret gets entropy, not a short window" and
  does not. A token only works when the person can be handed a link carrying both
  the reference and the secret. An invited colleague is on a different device from
  whoever invited them and never sees the API response the reference came back in.
  So `POST /auth/accept-invite` is keyed on the address they already know. Brute
  force stays bounded: five attempts on the one live row, and only somebody
  already inside can create another.
- **Accepting sets the password, stamps the credential and activates the
  employment in ONE transaction.** A spent code with no password set would leave
  an account nobody can ever enter.
- **Permission resolution now joins the employment and requires it active.**
  Without that a suspended employee kept every permission until their access token
  expired — up to fifteen minutes of full access after being switched off, which
  made "suspend" a suggestion rather than a control.

### 19.8 Still open

- **Verification delivery** has no provider. The seam exists and the flow is
  complete; in dev the code is logged, and in qa or prod a missing provider is
  logged as an error rather than silently dropping the send.
- **OAuth `state` is signed and expiring but not single-use.** Replay is bounded
  by the ten-minute window and by Meta rejecting a reused authorization code, so
  the practical exposure is small — but the design says single-use, and closing
  it needs somewhere to record spent nonces.
- **The ambiguous-send read-back** is not implemented. Such sends are cancelled
  rather than retried, choosing a missing reply an agent can resend over a
  duplicate reply to a customer.
- **Backfill** is enqueued on connect but no sync runner consumes `sync_jobs` yet.
- **Posts** are modelled and migrated but not synced or exposed.

---

## Appendix — sources checked (August 2026)

- NestJS releases and v12 scope — [github.com/nestjs/nest/releases](https://github.com/nestjs/nest/releases), [v12.0.0 PR](https://github.com/nestjs/nest/pull/16391), [InfoQ on the v12 roadmap](https://www.infoq.com/news/2026/04/nestjs-12-roadmap-esm/), [Trilon](https://trilon.io/blog/nestjs-12-is-coming)
- Node.js release schedule — [nodejs.org previous releases](https://nodejs.org/en/about/previous-releases), [endoflife.date/nodejs](https://endoflife.date/nodejs)
- TypeORM 1.0 and maintenance status — [InfoQ](https://www.infoq.com/news/2026/06/typeorm-1-released/), [typeorm releases](https://github.com/typeorm/typeorm/releases)
- npm supply-chain incidents — [Socket on keyv/cacheable](https://socket.dev/blog/popular-npm-packages-in-the-keyv-and-cacheable-namespaces-compromised-in-active-supply-chain), [CSA Singapore advisory](https://www.csa.gov.sg/alerts-and-advisories/advisories/ad-2026-009/), [Datadog Security Labs](https://securitylabs.datadoghq.com/articles/npm-worm-compromises-popular-npm-packages/), [Unit 42](https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/)
