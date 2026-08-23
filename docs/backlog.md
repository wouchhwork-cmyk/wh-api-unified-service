# What is left to do

Everything known to be missing or wrong, as of the review pass on
`feature/base-setup` (23 August 2026). Written to be picked up cold: each item says what is wrong, why it
matters, and roughly what it costs.

Grouped by **risk**, not by feature area — the first section is things that are
already shipped and already wrong, which is a different kind of urgent from things
that do not exist yet.

Sizes are rough: **S** under half a day, **M** a day or two, **L** longer.

---

## 0. What the review pass closed, and what it opened

A full review of the branch produced ~160 confirmed findings. The ones fixed are
struck through in place below; the ones NOT fixed are listed here so nothing is
quietly dropped.

The defects worth knowing about, because they say what kind of mistake this
codebase makes:

- **The relay could send a customer the same reply twice.** Its settlement writes
  shared a try with the Graph call, so a database error AFTER a successful send
  was reported as a send failure — and `markFailed` had no status guard, so it
  flipped a `sent` row back to `failed` and the relay re-claimed it.
- **`POST /conversations/:refId/status` had never worked.** It bound one parameter
  as both a column value and an `IN (...)` operand, which Postgres refuses, so it
  answered 500 for every request ever made to it. Found by calling it: no client
  called it and no test covered it.
- **Two keyset queries did not match their own ORDER BY**, so rows were silently
  unreachable — conversations with no messages yet, and half of any thread with
  backfilled history.
- **A reply to a MENTION was sent as a direct message addressed to a comment id**,
  and every top-level Facebook comment on one post collapsed into one
  conversation, because `parent_id` is the POST on a top-level comment.
- **Hiding an Instagram comment did nothing.** The parameter is `hide` there and
  `is_hidden` on a Page, and Meta ignores the wrong one silently.
- **`posts.like_count` and `posts.share_count` were never written**, because
  nothing asked Meta for a reaction summary — two columns the API sorts on.

### Still open, from the same review

| | Size | Note |
| --- | --- | --- |
| **Throttler keys grow without bound** | M | The in-memory store never evicts, so the key space is (throttled handlers × every client address ever seen) and a deploy resets every counter. Per-process limits also multiply by replica count. Needs Redis, or a sweep and a cap. |
| **`/health/detail` is readable by any viewer** | S | It is gated on `enterprise.view`, which every enterprise role holds, and returns platform-wide queue gauges plus database and Meta configuration. No tenant data, so metadata disclosure rather than a boundary break — but it also runs three unfiltered aggregate scans over the event ledgers on every call. |
| **Staff roles are a fiction** | M | `support` and `ops` are seeded as `RoleScope.Staff` templates and can never be granted: `employee_roles.enterprise_id` is NOT NULL behind a composite foreign key, and a staff template has no enterprise. Staff authority is the `has_all_enterprise_access` flag and nothing else. The permission query is at least fail-closed now — it re-checks the staff row rather than trusting the token. |
| **`GET /employees` is unpaginated** | S | It returns every employee of a business with no limit and no cursor, unlike every other list in the service. |
| **The correlation id is still client-supplied** | S | See §1.6 — unchanged. |
| **`LISTEN` clients have no TCP keepalive** | S | A socket reaped by a NAT gateway without FIN leaves a zombie listener, and the only cost is latency, because every worker still polls on its own timer. Deployment-dependent. |
| **A committed OpenAPI document** | S | `openapi:export` still points at a script that does not exist, so there is no contract snapshot and no breaking-change check. |

---

## 1. Wrong in code that already ships

These have no ticket in any product sense. They are defects in built features,
found by review or by hand-testing, and each one is a thing that will behave
incorrectly in production today.

### 1.1 The inbox path's test coverage — **S remaining**

Was **zero**. Now covered, all against real Postgres:

| File | What it pins down |
| --- | --- |
| `test/e2e/inbox.e2e.spec.ts` | 15 cases: assign, unassign, cross-tenant assign, status, thread pagination, malformed refs, nonsense cursors, no internal ids in a thread, idempotency (missing key, reused key, honest retry), cross-tenant read |
| `test/integration/conversation-workflow.spec.ts` | every status value, the resolved stamp, the assignee join, cross-tenant writes |
| `test/integration/outbound-settlement.spec.ts` | the duplicate-send guards, the lease fence, dead-lettering, the attempt budget |
| `test/integration/keyset-pagination.spec.ts` | both keyset defects, reproduced before being fixed |
| `test/unit/meta-webhook-signature.spec.ts` | 13 cases on HMAC verification — the only auth on a public write route |

**Still untested:** ingestion end to end (webhook → ledger → projector → domain)
and the relay's own loop. The projectors and `BackfillWorker` have no direct
tests at all; they were verified by hand against a live account, and the recipe
below is still the recipe.

| Step | Verified behaviour |
| --- | --- |
| `GET /webhooks/meta` | returns the bare `hub.challenge`, no envelope |
| Unsigned `POST` | `401`, nothing stored |
| Signed `POST` | `200 {"received":true}`, ledger key `facebook:comment:<id>:add` |
| Projector | customer, `comment_thread` conversation and inbound message created |
| Reply | `202 pending`, message + ledger row in one transaction |
| Relay | dead credential → `cancelled`, not retried; message `failed` |
| Idempotent retry | returns the ORIGINAL message; outbound count stays 1 |

The projectors are now the largest untested surface in the service, and the
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

### ~~1.4 The OAuth `state` token is not single-use~~ — WAS ALREADY DONE

Stale entry, corrected rather than fixed: `OauthStateRepository.consume` is a
conditional `UPDATE ... WHERE nonce = $1 AND consumed_at IS NULL AND expires_at >
now()` returning the row, so the first caller wins and a replay resolves to
nothing. `oauth_states_nonce_uniq` backs it and
`test/integration/oauth-state.spec.ts` covers it. The entry described the design
before the table existed.

### ~~1.5 Malformed reference ids are 500s on the conversation routes~~ — DONE

`RefIdParamSchema` is applied on every `/conversations` route, and
`test/e2e/inbox.e2e.spec.ts` asserts 422 rather than 500 on all four. The same
class of defect turned up twice more and is fixed with it: a client-supplied
`X-Forwarded-For` that is not an address was written into an `inet` column, and
an opaque cursor carrying `{"t":"nope"}` bound an Invalid Date into a query.

### 1.6 The correlation id is client-supplied — **S**

`RequestContextMiddleware` accepts an inbound `x-correlation-id` or
`x-request-id`. It is echoed in every response, written to `outbound_events`, and
used as the audit anchor — so a caller can choose the id their actions are filed
under. Fine as a trace hint, wrong as an audit key.

### 1.7 Audit coverage — **S remaining**

Mostly closed. Now written: staff impersonation (`impersonated`, the event a
customer is most entitled to see, and which previously left no trace at all),
platform-console reads of one business (`viewed`), conversation assignment
(`assigned`) and conversation status changes (`updated`).

Still silent: **auth** — login, `login_failed`, logout, verification and
invitation acceptance — though `AuditAction` declares all of them. A reply is
also still unaudited; the message row is the record, which is arguably enough,
but `Replied` exists in the enum and is unused.

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
- ~~**`recordDelivery` has no tenant predicate.**~~ DONE — it takes the
  enterprise and scopes on it, and the relay threads its own claimed row's
  tenant through. The one caller with no tenant (an event naming no enterprise)
  now says out loud that the message cannot be settled.
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
| ~~**Backfill**~~ | DONE | `BackfillWorker` claims `sync_jobs` and the reaper covers them. Four walks are implemented — posts, comments, conversations and Instagram `tags` for mention history — and they synthesise webhook-shaped rows into `inbound_events` so the live projectors do the work. What remains is Meta-side: `pages_read_user_content` for Facebook comments, and Advanced Access for conversation visibility. |
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
- ~~**Customer directory.**~~ DONE — `GET /customers`, searchable by name or
  handle, with the split given name and the Instagram handle, and a page in the
  portal.
- ~~**Posts.**~~ DONE — synced by the backfill, served by `GET /posts` with
  previews, engagement counts and a channel filter, and a page in the portal.
  What is missing is a post DETAIL view showing its comment thread. **M**
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

- ~~**Inbox UI**~~ — built: list, filters, thread with pagination, reply with a
  reply-window gate, assignment, status, and live updates over SSE. What is left
  is a design pass, not a screen. **DONE**
- **A post detail view** showing a post's own comment thread. **M**
- **Customer → conversations click-through** from the directory. **S**
- **Live updates on the posts and customers pages** — the inbox has them; those
  two still need a reload. **S**
- **Queue depth is not surfaced anywhere.** `/health/detail` carries the gauges
  and no screen reads them. **S**
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
| ~~**CI pipeline**~~ | DONE | `.github/workflows/ci.yml` runs typecheck, lint, format, the whole suite, `dist/migrate.js` the way a deploy does, and `db:check`; schema parity is a separate job so a deliberate drift does not turn the suite red. `pnpm verify` and `pnpm predeploy` run the same gates locally. |
| **Committed OpenAPI document** | S | `package.json` has an `openapi:export` script pointing at `scripts/export-openapi.ts`, **which does not exist**. So the script fails, there is no committed `openapi.json`, and no breaking-change check. |
| **Regenerate the migration before the first deploy** | M | Development now uses `pnpm db:sync`, so the migration is deliberately drifting from the entities. `pnpm test:schema` is the alarm. Nothing is in production yet, so the cheapest path is to regenerate the initial migration from the settled schema rather than accumulate deltas. |
| **Docker image never built** | S | The Dockerfile and compose entries exist and have never been exercised. It can at least run a migration now — `dist/migrate.js` is compiled into it, which it was not before, so the mandated migrations-then-code order is executable rather than only documented. |
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
