# Wouchh — Unified API

A multi-tenant B2B platform where a business connects its social accounts
(Meta → Facebook Pages and Instagram) and manages **chats, comments and posts**
from one place.

## Documentation

| Document | What it decides |
| -------- | --------------- |
| [docs/schema.md](docs/schema.md) | The data: 25 tables, their keys, and the reasoning behind each name and constraint |
| [docs/backend-design.md](docs/backend-design.md) | The code: stack, layering, transactions, auth, API contract, deployment, and the Meta integration. §19 records what building it changed |

## Running it

Requires Node 24, pnpm 10, and Docker.

```bash
pnpm install                  # exact versions, install scripts off (see design §2)
docker compose up -d postgres # Postgres 18 on host port 5544, database wouchh_dev
pnpm db:migrate               # hand-written SQL migrations
pnpm db:seed                  # features, permissions, system role templates
pnpm build && pnpm start:local
```

The API listens on `http://localhost:3000/api/v1`, with Swagger at
`http://localhost:3000/api/docs`. Workers are a separate process sharing the same
image: `node --env-file=.env.dev dist/workers/main.js`.

### Changing the schema while developing

Two ways in, and which one you use depends on where you are.

```bash
pnpm db:sync      # dev only: edit an entity, run this, carry on
pnpm db:migrate   # qa and prod: hand-written SQL, reviewed, ordered
```

`db:sync` lets TypeORM create and alter the TABLES to match the entities, then
re-applies the 88 objects entity metadata cannot express — 34 unique indexes
(several of them partial), 55 supporting indexes, 69 foreign keys routed through
`enterprise_id`, 2 CHECK constraints, the `updated_at` triggers, and the grant
that makes `audit_logs` append-only.

**Synchronize alone would be destructive here, not merely incomplete.** Run
against a database built by the migration it emits 176 statements, of which 103
are `DROP INDEX` and 69 are `DROP CONSTRAINT`. It would take out every unique
constraint, every foreign key and both CHECKs — including the composite keys that
make a cross-tenant row impossible — and leave a database that still boots. That
is why `synchronize` stays `false` in the DataSource and lives behind a command
instead: sync-on-boot would do this on every start.

Both paths run the same module, `src/database/schema/schema-objects.ts`, and
`test/integration/schema-parity.spec.ts` builds a database each way and compares
the index definitions, foreign keys, checks, triggers and columns — so the two
cannot drift apart quietly.

`db:sync` refuses to run unless `NODE_ENV=dev`.

### Looking at the database

Port **5544**, not 5432: local PostgreSQL installations already hold the usual
ports.

| | |
| --- | --- |
| Host | `localhost` |
| Port | `5544` |
| Database | `wouchh_dev` |
| User | `wouchh` |
| Password | `DB_PASSWORD` in `.env.dev` |

For pgAdmin, `docs/pgadmin-servers.json` is importable as-is: **Object → Import/
Export Servers → Import**, pick the file. It carries no password; pgAdmin will
prompt.

**Build with SWC, not tsx.** tsx transpiles with esbuild, which does not emit
decorator metadata, so every type-reflected injection resolves to `undefined`
(backend-design.md §19.1). `pnpm build` is correct; `tsx src/main.ts` is not.

### Meta integration

Off by default. To enable it, put real credentials in `.env.local` (gitignored)
with `META_ENABLED=true`; see `.env.example` for the variable names. With it off
the service runs normally and the webhook routes refuse to authenticate, because
an HMAC under an empty secret is one anybody can compute.

## Tests

```bash
pnpm test              # unit
pnpm test:integration  # against the real Postgres from docker compose
pnpm test:e2e          # through the real application graph
```

Integration and e2e tests run against a real database on purpose: every
interesting constraint here is a Postgres feature a mock cannot reproduce — a
mocked repository would accept the duplicate a partial unique index rejects.

## What works today

- Business signup, first-login verification, sessions, enterprise switching
- Feature + action level access control, resolved per request
- Meta connection: OAuth, Page and Instagram discovery, webhook subscription
- Webhook ingestion into the transport ledger, with deduplication
- Projection into customers, conversations and messages
- The inbox: listing, reading a thread, replying, assigning, resolving
- Postgres-only workers: projector, outbound relay, lease reaper, sweeper

## What does not

- Verification delivery has no email or SMS provider wired
- Backfill jobs are enqueued but no sync runner consumes them
- Posts are modelled but not synced or exposed
- The ambiguous-send read-back is not implemented; such sends are cancelled

## Conventions worth knowing before changing anything

- **The database is `snake_case`, the code is `camelCase`**, and the mapping is
  mechanical. A hand-written column alias breaks it.
- **Migrations own all DDL.** Entities carry columns only. `synchronize` is
  `false` everywhere, because the synchroniser cannot represent the partial
  indexes, expression indexes and composite foreign keys the isolation and
  idempotency guarantees depend on — and would `DROP` them as drift.
- **Every tenant-scoped query and write names `enterprise_id`**, and it comes
  from the access token, never from a request body.
- **Business logic lives only in services.** Controllers parse, call and map;
  repositories hold queries and no business rules.
- **No network I/O inside a transaction.** Write the `outbound_events` row,
  commit, and let the relay make the call.
