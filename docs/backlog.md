# What is left to do

Everything known to be missing or wrong, as of the employees/platform work being
finished. Written to be picked up cold: each item says what is wrong, why it
matters, and roughly what it costs.

Grouped by **risk**, not by feature area — the first section is things that are
already shipped and already wrong, which is a different kind of urgent from things
that do not exist yet.

Sizes are rough: **S** under half a day, **M** a day or two, **L** longer.

---

## 1. Wrong in code that already ships

These have no ticket in any product sense. They are defects in built features,
found by review or by hand-testing, and each one is a thing that will behave
incorrectly in production today.

### 1.1 The inbox path has no automated tests at all — **M**

Ingestion, projection, the inbox reads, the reply transaction and the relay have
**zero** test coverage. The employees rename touched
`conversations.assigned_to_employee_id`, `messages.sent_by_employee_id` and both
projectors, and nothing in the suite would have failed if that rename had broken
them. It was verified by hand instead:

| Step | Verified behaviour |
| --- | --- |
| `GET /webhooks/meta` | returns the bare `hub.challenge`, no envelope |
| Unsigned `POST` | `401`, nothing stored |
| Signed `POST` | `200 {"received":true}`, ledger key `facebook:comment:<id>:add` |
| Projector | customer, `comment_thread` conversation and inbound message created |
| Reply | `202 pending`, message + ledger row in one transaction |
| Relay | dead credential → `cancelled`, not retried; message `failed` |
| Idempotent retry | returns the ORIGINAL message; outbound count stays 1 |

**Do this first.** It is the largest untested surface in the service, and the
recipe above is exactly the test.

### 1.2 Removing somebody does not end their sessions — **S**

`AuthService.refresh` only re-checks employment when the caller passes
`?enterpriseRefId=`. Without it no employment lookup happens at all, so a
suspended or removed person keeps refreshing indefinitely. `revokeAllForIdentity`
exists on the session repository and has **no callers** — nothing revokes sessions
when an employment, identity or business is suspended.

Permission resolution now requires an active employment, so their access token
resolves to nothing on the next request. But they can still mint fresh tokens.

### 1.3 Sessions are unbounded — **S**

Every login and every enterprise selection inserts a `sessions` row, with no cap
and no revocation of prior sessions. Rows are removed only by the 30-day retention
sweep. No "sign out everywhere".

### 1.4 The OAuth `state` token is not single-use — **M**

Signed and expiring, but replayable inside its window — despite the design doc and
the endpoint's own Swagger description claiming single-use. Closing it needs
somewhere to record spent nonces.

### 1.5 Malformed reference ids are 500s on the conversation routes — **S**

None of the six `/conversations` routes validate the path parameter, so
`GET /conversations/not-a-uuid` reaches Postgres, raises `22P02` and surfaces as
`INTERNAL_ERROR`. The platform and employees routes already use
`RefIdParamSchema`; apply it here.

### 1.6 The correlation id is client-supplied — **S**

`RequestContextMiddleware` accepts an inbound `x-correlation-id` or
`x-request-id`. It is echoed in every response, written to `outbound_events`, and
used as the audit anchor — so a caller can choose the id their actions are filed
under. Fine as a trace hint, wrong as an audit key.

### 1.7 Audit coverage is two modules deep — **M**

Only the platform console and the employees module write `audit_logs`. Auth
(login, logout, verification, invitation acceptance) and the inbox (reply,
assign, status change) write nothing, though `AuditAction` already declares
`Login`, `LoginFailed`, `Logout`, `Verified`, `Assigned` and `Replied`.

### 1.8 One test fails intermittently, unexplained — **M**

Twice now, a single test has failed in a combined `pnpm test:all` run and then
passed on every subsequent run — including three consecutive clean runs
immediately afterwards, and every per-project run. Both times unreproducible, so
both times I could not name the test with confidence.

Recorded rather than dismissed, because "fails one run in N" is the failure mode
that erodes trust in a suite fastest, and the suite is the only thing standing
between a rename and a silent break.

Where to look first: everything shares one database (`wouchh_test`), and
`beforeEach` TRUNCATEs. Root-level `fileParallelism: false` and `maxWorkers: 1`
serialise files, so it is not two files racing — more likely an app instance from
a finished file still holding a connection, or a worker poller started by one
suite touching rows during another. A per-file database, or capturing the failure
with `--reporter=json` on a loop until it reproduces, would settle it.

### 1.9 Smaller, but real — **S each**

- **Resend cooldown is configured and unenforced.** `resendCooldownMs` is read by
  nothing; only the hourly per-destination cap of 5 applies, and it counts every
  verification kind to that destination. There is also no resend endpoint.
- **`recordDelivery` has no tenant predicate.** It keys on
  `outbound_event_id` alone, unlike every other write in that repository.
- **Only `archived` blocks a reply,** despite a `CONVERSATION_CLOSED` code
  existing; resolved and closed threads are still repliable.
- **A role's scope is not enforced at assignment.** Only the composite foreign
  keys stand between a staff-scoped role and a business employee.
- **Ambiguous sends are cancelled, never reconciled.** Where we cannot tell
  whether a message left, we drop it — the safe choice, but no read-back is
  attempted afterwards.
- **`POST /conversations/:refId/read` parses nothing.** The one mutation with no
  schema; any body is accepted and ignored.

---

## 2. Built, but nothing consumes it

Machinery that exists, is migrated, has indexes, and is never read.

| | Size | What is missing |
| --- | --- | --- |
| **Backfill** | M | `sync_jobs` rows are enqueued when a channel connects. Nothing claims them, so a business that connects a Page sees only what arrives *after* it connected — no history. The lease reaper does not cover `sync_jobs` either, though the index for it exists. |
| **Attachments** | M | Inbound media is never downloaded. A DM with an attachment becomes a message marked as an image regardless of real type, and no `message_attachments` row is written — despite a partial index built for exactly that query. |
| **Token expiry warnings** | S | `SweeperWorker.flagExpiringTokens` emits a debug line and moves no token to an expiring state, so a channel whose token dies simply goes quiet. `EXPIRY_SWEEP_CRON` is validated, plumbed to config, and read by nothing. |
| **Feature expiry** | S | Nothing acts on `enterprise_features.expires_at`; a feature never moves to `expired` on its own. |
| **Channel retirement** | S | No code path writes `is_deleted = true` or moves a channel to `disconnected`/`expired`. The connect flow only upserts the Pages currently discovered, so a Page that goes away stays active forever. |

---

## 3. Endpoints that do not exist

The schema supports all of these; nothing exposes them.

- **Change an employee's role** after creation. Today a role is set once, at
  creation, and cannot be changed. **S**
- **Create or edit a role.** A business gets its four copied templates and cannot
  alter them. **M**
- **A business requesting a feature.** `access_requested`, the `features.request`
  permission and the whole request path are modelled and unreachable — only an
  admin can grant. **S**
- **Customer directory.** `CustomerRepository.listDirectory` is written, with
  trigram search; no controller exposes it. **S**
- **Posts.** Modelled and migrated, never synced or served. **L**
- **Comment hide and delete.** The outbound event types and relay senders exist;
  no endpoint triggers them. **S**
- **Password reset.** Configured as a token flow in `verification.config.ts`,
  with no endpoint. Note the same problem the invitation had: a token needs a
  link, so the reset page needs the reference and the secret in the URL. **M**
- **Resend a verification code.** **S**

---

## 4. Meta integration

- **It has never run against real Meta credentials from this codebase.** Every
  Graph call mirrors a proven implementation, and the local tests use fake but
  well-formed credentials. Until it runs once for real, treat the whole flow as
  unproven. **M**
- **`comments` is not subscribed.** Pages are subscribed to
  `messages,messaging_postbacks,feed,mention`. The `case 'comments'` branch of the
  field mapper is therefore dead — comment events arrive as `feed` changes, which
  is what the projector handles, so this is latent rather than broken. **S**
- **Instagram** is discovered and stored, and its send path inherits the parent
  Page's token, but none of it has been exercised against a real account. **M**

---

## 5. Frontend

The portal is deliberately plain, with no build step and no dependencies. It
exists to prove the API flows, and none of it is written to last.

- **Inbox UI** — the largest missing screen, and the product's whole point. **L**
- **Connect Meta UI** — a button that starts the OAuth flow and shows connected
  channels. Blocked on §4. **M**
- **Feature request UI** for a business, once §3 exists. **S**
- **Role management UI**, once §3 exists. **M**
- **A real design pass**, and a decision on whether to keep vanilla JS or move to
  a framework. Worth deferring until the flows settle. **L**
- **No frontend tests of any kind.** **M**

---

## 6. Release readiness

| | Size | Note |
| --- | --- | --- |
| **CI pipeline** | M | `.github/workflows` does not exist. Nothing enforces typecheck, lint, format, tests, `db:check`, or `pnpm test:schema` — all of which pass today and can silently stop. |
| **Committed OpenAPI document** | S | `package.json` has an `openapi:export` script pointing at `scripts/export-openapi.ts`, **which does not exist**. So the script fails, there is no committed `openapi.json`, and no breaking-change check. |
| **Regenerate the migration before the first deploy** | M | Development now uses `pnpm db:sync`, so the migration is deliberately drifting from the entities. `pnpm test:schema` is the alarm. Nothing is in production yet, so the cheapest path is to regenerate the initial migration from the settled schema rather than accumulate deltas. |
| **Docker image never built** | S | The Dockerfile and compose entries exist and have never been exercised. |
| **A real email/SMS provider** | M | `OTP_REALTIME_ENABLED=false` everywhere, and every code is `666666`. Production refuses to boot that way, so this blocks any real deployment. The provider seam is one binding in the communication module. |
| **Metrics** | M | Structured logs and correlation ids exist; there are no counters, latencies or retry gauges. `@nestjs/terminus` is a declared dependency with zero references — the health module is hand-rolled. |
| **Secret manager** | M | Secrets come from the environment. No rotation path beyond `TOKEN_ENCRYPTION_KEY_ID`, which is designed for it and untested. |

Deferred by design, not oversights: row-level security, partitioning, read
replicas, refresh-token rotation.

---

## 7. Decisions still open

- **PostgreSQL 17.5 or 18 locally.** Development runs on the native 17.5 on 5432.
  The native 18 on 5433 has a different password. Compose pins 18 because that is
  what production will run. Nothing in the schema needs newer than 16, so this is
  about parity, not capability.
- **How secrets live in `.env.dev`.** The file is tracked with placeholder keys
  and real credentials are layered on top as uncommitted changes. That works only
  as long as nothing does `git add -A` on it — and something in the IDE appears to
  be auto-pushing. `git update-index --skip-worktree .env.dev` would make it
  impossible to stage, at the cost of blocking legitimate edits when a new config
  key is added.
- **Whether the test database stays separate.** It is separate now
  (`wouchh_test`), which is why a test run no longer wipes what you are clicking
  through. Keep it.

---

## Suggested order

1. **§1.1** — tests over the inbox path. Everything else is safer once the largest
   untested surface has a net under it.
2. **§1.2, §1.3, §1.5, §1.6** — the small correctness fixes, together in one pass.
3. **§6 CI** — so the gates that pass today keep passing.
4. **§4** — Meta against real credentials, since the product does nothing useful
   until a real Page is connected.
5. **§2 backfill** and **§5 inbox UI** — the two things that make a connected Page
   worth having.
6. Everything else, by whatever the product needs next.
