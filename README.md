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
pnpm install                 # exact versions, install scripts off (see design §2)
docker compose up -d postgres # Postgres 18 on host port 5544
pnpm db:migrate              # hand-written SQL migrations
pnpm db:seed                 # features, permissions, system role templates
pnpm build && node --env-file=.env.dev dist/main.js
```

The API listens on `http://localhost:3000/api/v1`, with Swagger at
`http://localhost:3000/api/docs`. Workers are a separate process sharing the same
image: `node --env-file=.env.dev dist/workers/main.js`.

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
