# Code review — `feature/base-setup`

**Date:** 2026-08-23 · **HEAD:** `eefbeda` · **Base:** `main` (1 file — this branch *is* the service)
**Scale:** 34 commits · 252 files · +40,289 lines · 22.4k LOC `src` / 3.4k LOC `test`
**Method:** 78 agents across 21 review dimensions, every finding adversarially verified

---

## Contents

1. [Verdict](#1-verdict)
2. [Gates as they stand today](#2-gates-as-they-stand-today)
3. [Findings summary](#3-findings-summary)
4. [Blocking findings](#4-blocking-findings) — 1 critical, 25 high
5. [Medium findings](#5-medium-findings)
6. [Low findings](#6-low-findings)
7. [Cross-cutting patterns](#7-cross-cutting-patterns)
8. [Checklist gate](#8-checklist-gate)
9. [Claims that did not survive verification](#9-claims-that-did-not-survive-verification)
10. [What to do first](#10-what-to-do-first)
11. [Change summary](#11-change-summary)
12. [Method and limits](#12-method-and-limits)

---

## 1. Verdict

**Do not merge yet.** 16 P0 checklist sections fail.

This is unusually well-built code for a first branch. The layering is real — controllers stay thin,
repositories own SQL, the transaction manager is used where atomicity matters. Ingestion idempotency is
enforced by actual unique indexes rather than application checks. The logger redacts by allowlist rather
than denylist. The ledger claim statements are correct `SELECT ... FOR UPDATE SKIP LOCKED`. The code
comments frequently explain *why*, not what. None of what follows argues for a rewrite.

What will hurt in production is narrower and sharper than "the code is bad". Three things stand out.

**First**, the outbound relay can send a customer the same reply twice. A settlement write that fails
after a successful Graph call re-queues the event, and `markFailed` has neither a status guard nor a lease
fence to stop it.

**Second**, the discipline that makes the ingest side safe was not applied consistently. `markSent` is
lease-fenced and its three siblings are not. Ingestion idempotency is a database constraint while reply
idempotency is an optional client-supplied key. Correctness here is a pattern that was applied in some
places and forgotten in others — exactly the kind of gap that survives review.

**Third**, the inbox — the product — has zero automated tests, and it is where the most confirmed defects
live. Facebook's `parent_id` is the *post* id for a top-level comment, so every commenter on a post
currently collapses into one conversation. That is a product-breaking bug that no test would have caught,
because there are no tests.

Around the code, the operational story is documented but not executable: the runtime image cannot run
migrations, `db:revert` drops every table with no guard, and no CI configuration exists at all, so every
gate the design doc names is enforced only by memory.

---

## 2. Gates as they stand today

Run in this session against local PostgreSQL 18 — not taken on trust.

| Gate | Result | Detail |
| --- | --- | --- |
| `pnpm typecheck` | **Pass** | clean |
| `pnpm lint` | **Pass** | `--max-warnings 0`, clean |
| `pnpm format:check` | **Pass** | all files match Prettier |
| `pnpm test` | **Pass** | 9 files, 81 tests |
| `pnpm test:integration` | **Pass** | 27 passed, 1 skipped |
| `pnpm test:e2e` | **Pass** | 51 passed |
| `pnpm test:schema` | **Never runs** | the only setter of `SCHEMA_PARITY`; skipped by both `test:integration` and `test:all` |
| CI | **Absent** | no `.github/`, GitLab, Jenkins, CircleCI or Buildkite config anywhere in the repo |

Every gate passes, and nothing enforces that they keep passing. The schema-parity check that commit
`a303476` introduced as "a pre-deploy gate" runs only when a human types `pnpm test:schema`.

---

## 3. Findings summary

| | Count |
| --- | --- |
| Raised | 307 |
| Confirmed by an adversarial verifier | 228 |
| Plausible (concern real, failure path not fully confirmable) | 42 |
| Refuted with counter-evidence | 11 |
| **Critical** | **1** |
| **High** | **25** |
| Medium | 109 |
| Low | 93 |

Findings marked **[converged]** were found independently by three or four reviewers who could not see each
other's work — the strongest available signal that a finding is real. **[backlog]** marks items
`docs/backlog.md` already records.

---

## 4. Blocking findings

### 4.1 Duplicate sends and ledger integrity

---

#### B1 — A failed settlement write after a successful Graph send duplicates the customer's reply

**Severity:** Critical · **Verified:** confirmed, and re-verified by hand
**Location:** `src/workers/outbound-relay.worker.ts:165`, `src/database/repositories/outbound-event.repository.ts:176`

**Why it breaks.** An agent replies to a comment. `graph.replyToComment` succeeds, Meta creates the
comment, `markSent` commits. Then `recordDelivery` hits a `statement_timeout` (`57014`) or a dropped pool
connection. Because that write sits *inside* the send `try` block, the catch routes to
`handleSendFailure`. The error is not a `GraphApiError`, so `scheduleRetry` returns a date and `markFailed`
flips a row whose status is already `sent` back to `failed` with `next_attempt_at ≈ now`.

`markFailed`'s WHERE clause is `id = $1` alone — no status guard, no lease fence — unlike `markSent`, which
correctly carries `AND lease_owner = $4`:

```sql
-- markSent (correct, fenced)
UPDATE outbound_events
   SET status = $2, sent_at = now(), platform_event_id = $3,
       lease_owner = NULL, lease_expires_at = NULL
 WHERE id = $1 AND lease_owner = $4
RETURNING id

-- markFailed (unfenced, no status guard)
UPDATE outbound_events
   SET status = CASE WHEN ... THEN $2 ELSE $3 END,
       ...
       next_attempt_at = $5, lease_owner = NULL, lease_expires_at = NULL
 WHERE id = $1
```

Seconds later the relay re-claims the row and posts the identical reply to the customer, overwriting
`platform_event_id` so no trace of the first send survives.

**Fix.** Move `markSent`/`recordDelivery` out of the send `try` into their own catch that logs loudly and
returns without touching ledger status. Add `AND status <> 'sent'` to `markFailed`. Two lines.

---

#### B2 — Outbound `cancel` and `markFailed` are not lease-fenced

**Severity:** High · **Location:** `src/database/repositories/outbound-event.repository.ts:205`

**Why it breaks.** Relay A claims 20 events on one 120 s lease (`WORKER_LEASE_SECONDS=120`,
`WORKER_BATCH_SIZE=20`). Meta stalls at the 10 s per-request timeout, so by event 14 the lease has expired
and `LeaseReaperWorker` has reset the row to `pending`. Relay B claims it and starts sending. A's own send
then fails; A calls `markFailed` unfenced, clearing B's lease and re-queueing the row while B is still
delivering. B's fenced `markSent` returns false and records nothing. The row is claimed a third time and
the customer receives the reply twice.

**Fix.** Add `AND lease_owner = $n` to `cancel` and `markFailed`, return the affected count, and have
`settleAsFailed`/`handleSendFailure` skip `recordDelivery` when the fence rejects the write. Pass
`this.leaseOwner` through `settleAsFailed`.

---

#### B3 — The lease reaper re-queues rows still in `sending`

**Severity:** High · **Location:** `src/database/repositories/outbound-event.repository.ts:221`

**Why it breaks.** A reply whose Graph call is merely *slow* — not failed — is reclaimed and re-dispatched
while the first request is still in flight. The reaper cannot distinguish a dead worker from a slow one.

**Fix.** Reclaim only rows whose lease has expired *and* whose worker heartbeat is stale, or require an
explicit `sending → pending` transition that checks elapsed time against the Graph client's own timeout
ceiling.

---

#### B4 — A Meta rate limit dead-letters an agent's reply in about three seconds

**Severity:** High · **Location:** `src/workers/outbound-relay.worker.ts:300`

**Why it breaks.** Rate-limit errors are classified as ordinary retryable failures against a 3-attempt
budget with sub-second backoff. A brief Meta throttle burns all three attempts in roughly three seconds
and the reply is dead-lettered — a customer-visible message silently lost to a condition specifically
designed to be waited out.

**Fix.** Give rate-limit codes (4, 17, 32, 613) their own class: do not consume the attempt budget, and
back off on the window Meta advertises in `X-App-Usage` / `X-Business-Use-Case-Usage`.

---

#### B5 — `sync_jobs.attempt_count` counts claims, not failures

**Severity:** High · **Location:** `src/database/repositories/sync-job.repository.ts:104`

**Why it breaks.** The claim statement increments `attempt_count` every time a worker picks the job up, and
a multi-slice backfill is claimed once per slice. A job that legitimately needs twenty passes exhausts a
3-attempt budget on pass three and dead-letters the moment anything transient happens.

**Fix.** Increment on failure, not on claim; or track slices and failures in separate columns.

---

#### B6 — Paused sync jobs are terminal and block re-enqueue forever

**Severity:** High · **Location:** `src/database/repositories/sync-job.repository.ts:221`

**Why it breaks.** One transient block pauses the job. Nothing can move it out of `paused`, and the
re-enqueue path treats an existing row as "already scheduled". That channel's history never arrives and no
alert fires.

**Fix.** Make `paused` resumable — either a reaper that ages it back to `pending`, or exclude it from the
"already scheduled" predicate.

---

### 4.2 Authentication, authorization and secrets

---

#### B7 — Any holder of `employees.invite` can grant the owner role

**Severity:** High · **Location:** `src/modules/employees/employees.service.ts:81`

**Why it breaks.** The invite path accepts any role name in the tenant, including `owner`. A manager whose
only elevated permission is "can invite people" invites an accomplice — or themselves by proxy — as owner
and takes over billing, connections and every employee record.

**Fix.** Refuse to grant a role whose permission set is not a subset of the caller's own, and gate `owner`
behind a dedicated permission that `employees.invite` does not imply.

---

#### B8 — Account lockout is evaluated only after the password verifies

**Severity:** High · **Location:** `src/modules/auth/auth.service.ts:111`

**Why it breaks.** The lockout check runs on the success branch. Wrong passwords increment the counter but
are never stopped by it, so the control that exists to bound brute force does not bound anything. Combined
with auth sharing the generic 120 req/min bucket, an attacker gets effectively unlimited attempts.

**Fix.** Check the lock *before* verifying the password, and return the same generic failure either way so
the lock state is not an oracle.

---

#### B9 — A platform-wide superadmin password is committed and re-applied on every boot [converged]

**Severity:** High · **Location:** `.env.dev:69`

**Why it breaks.** `1234567890` for `admin@wouchh.com` is in git history, and
`PlatformAdminBootstrapService` re-provisions it at every startup — so changing the password in the
database does not stick. Any environment that inherits `.env.dev` gets a known full-platform credential
that heals itself.

**Fix.** Remove the credential from the committed file, require it from a secret manager, and make
bootstrap provision only when the account is absent — never re-apply over an existing one.

---

#### B10 — Production refuses a placeholder JWT secret and pepper, but never checks the token-encryption key [converged]

**Severity:** High · **Location:** `src/config/env.schema.ts:168`

**Why it breaks.** The prod refinement forces `JWT_ACCESS_SECRET` and `VERIFICATION_HMAC_PEPPER` to be
replaced, so an operator copying the `.env.dev` block replaces exactly those two and silently carries
`TOKEN_ENCRYPTION_KEY_K1` — a valid 32-byte key whose plaintext is in the public history — into production.
Every tenant's long-lived Meta page token is then encrypted with a key anyone with repo access already has.

**Fix.** Extend the prod refinement over every `TOKEN_ENCRYPTION_KEY_K*` and reject known placeholders,
exactly as the JWT secret is handled. Rotate the value out of the repo.

---

#### B11 — `.env.dev` is `skip-worktree`, so a live Meta app secret sits on disk while `git status` reports clean

**Severity:** High · **Location:** `.env.dev:46`

**Why it breaks.** The bit hides local credential edits from `git status` on this machine only. A second
clone has no such bit, so the next `git add -A` publishes `FB_APP_SECRET` into shared history. It also
means the branch *as committed* cannot reach Meta at all, so the live-verification claims in the commit
messages are not reproducible by a reviewer.

**Fix.** Clear the bit (`git update-index --no-skip-worktree .env.dev`), strip `FB_*` from the tracked
file, and put real credentials in the already-ignored `.env.local`, which the `--env-file-if-exists`
layering supports. Rotate the secret if it has been shared.

---

#### B12 — Dedicated `LISTEN` clients disable TLS certificate verification

**Severity:** High · **Location:** `src/modules/inbox/inbox-events.service.ts:120`,
`src/workers/queue-listener.service.ts:86`

**Why it breaks.** Two long-lived out-of-pool connections carry `rejectUnauthorized: false` while the main
pool enforces verification. They are the channels that stream inbox activity, so the one connection nobody
watches is the one an active network attacker can sit in front of.

**Fix.** Build both clients from the same TLS configuration as the pool. If a self-signed cert is needed in
dev, express that through the existing config surface rather than a hardcoded downgrade.

---

#### B13 — Staff identity is trusted from the JWT, so a revoked staff member keeps cross-tenant reach

**Severity:** High · **Location:** `src/modules/auth/permission.service.ts:40`

**Why it breaks.** The staff branch resolves authority from the token's claim rather than re-reading
`staff_members`. Combined with the fact that nothing revokes sessions — `revokeAllForIdentity` has zero
callers — a removed super admin keeps full cross-tenant access until their token expires, and can keep
refreshing it.

**Fix.** Re-read the staff row on each request as the employee branch already re-reads employment, and wire
`revokeAllForIdentity` into suspension, removal and password change.

---

#### B14 — Staff impersonation into any tenant leaves no audit row

**Severity:** High · **Location:** `src/modules/auth/auth.service.ts:353`

**Why it breaks.** `switchEnterprise` mints a token for an arbitrary tenant for any full-access staff member
and writes nothing to `audit_logs`. The single most sensitive action in the product — an employee of the
vendor entering a customer's inbox — is unreconstructable after the fact. Every platform-console read of
tenant data is likewise unaudited.

**Fix.** Audit the switch with actor, target enterprise and reason, and audit platform-console reads.

---

#### B15 — A client-supplied `X-Forwarded-For` that is not an IP destroys the audit row and 500s login

**Severity:** High · **Location:** `src/modules/audit/audit.service.ts:69`

**Why it breaks.** The header lands in an `inet` column unvalidated. Sending
`X-Forwarded-For: unknown` makes the audit insert raise `22P02`, which is swallowed — the action succeeds
and no audit row exists. The same header on `POST /auth/login` makes the session insert throw and returns
500. A caller effectively chooses whether their actions are recorded.

**Fix.** Validate through `net.isIP()` in `RequestContextMiddleware` and store `null` on failure, so
`audit_logs`, `sessions` and `verifications` all degrade to "unknown IP" instead of breaking.

---

### 4.3 Inbox correctness — the product surface

---

#### B16 — Every top-level Facebook comment on a post collapses into one conversation [converged]

**Severity:** High · **Location:** `src/modules/inbox/comment-normalizer.ts:103`

**Why it breaks.** The normalizer threads on `parent_id`, but Meta sets `parent_id` to the **post** id for a
top-level comment. So the thread key for every distinct commenter on a post is the same string, and all of
them merge into a single conversation attributed to whichever customer arrived first. On any post with more
than one commenter the inbox is wrong, and replies go to the wrong person.

**Fix.** Use `parent_id` only when it identifies a comment; for a top-level comment, thread on the comment's
own id. Distinguish the two by comparing against the post id already carried in the payload.

---

#### B17 — The business's own comments are projected as customer comments

**Severity:** High · **Location:** `src/modules/inbox/comment-projector.service.ts:122`

**Why it breaks.** Nothing filters comments authored by the connected Page. Each agent reply that echoes
back through the webhook creates a customer record for the business itself and a conversation attributed to
it, inflating customer counts and engagement metrics with the business's own activity.

**Fix.** Drop inbound comments whose author id equals the channel's `platform_channel_id` (or its parent
Page), the way the DM projector already handles `is_echo`.

---

#### B18 — Replying to a Mention is queued as a direct message addressed to a post id [converged]

**Severity:** High · **Location:** `src/modules/inbox/inbox.service.ts:181`

**Why it breaks.** The event-type choice is a two-way ternary: `CommentThread` becomes a comment reply,
everything else becomes a DM. A `Mention` conversation's thread key is `mention:<postOrCommentId>`, so the
relay calls `sendDirectMessage` with a post id as the Messenger recipient. `evaluateReplyWindow` returns
`canReply: true` for a mention, the API answers 202 `pending`, and the message can never be delivered.

**Fix.** Move `composeThreadKey` and its inverse into one module returning `{kind, platformId}`, and dispatch
on the parsed kind — refusing `Mention` and `Review` explicitly rather than silently treating them as DMs.

---

#### B19 — `last_inbound_at` is written unconditionally, closing the 24-hour reply window [converged]

**Severity:** High · **Location:** `src/database/repositories/conversation.repository.ts:193`

**Why it breaks.** `recordMessage` assigns rather than taking the maximum. Backfill walking history after a
live message has arrived moves `last_inbound_at` backwards, and the reply gate then refuses valid replies on
a conversation the agent can see is active. The gate added in `ef33adb` makes this user-visible.

**Fix.** `last_inbound_at = GREATEST(last_inbound_at, $n)`, and the same for `last_message_at`.

---

#### B20 — Reply idempotency is opt-in, unscoped, and returns the wrong thing on conflict [converged]

**Severity:** High · **Location:** `src/shared/contracts/inbox/inbox.contract.ts:34`,
`src/modules/inbox/inbox.service.ts:126`

**Why it breaks.** The one write that reaches a customer has no idempotency unless the client opts in.
When a key *is* supplied, three further problems compound:

- the lookup is not scoped to `conversation_id` or `is_internal_note`, so a reused key returns another
  conversation's message and silently sends nothing;
- there is no unique index behind it, so it is a check-then-insert across a transaction boundary;
- a concurrent retry returns `409 DUPLICATE_MESSAGE` rather than the original message, contradicting the
  endpoint's own documented contract.

**Fix.** Make the key required (or derive one server-side from actor + conversation + body hash), scope the
lookup by `conversation_id` and `is_internal_note`, back it with a unique index, and return the original
message on conflict.

---

### 4.4 Pagination

---

#### B21 — Inbox keyset pagination is NULL-unsafe: page 2 returns zero rows [converged]

**Severity:** High · **Location:** `src/database/repositories/conversation.repository.ts:152`

**Why it breaks.** The cursor predicate compares against a nullable `last_message_at`. Any comparison with
NULL yields NULL, which filters the row out — so the moment a conversation exists with no messages, paging
past page 1 returns an empty page and the client concludes the inbox has ended.

**Fix.** Sort on `COALESCE(last_message_at, created_at)` — or make the column NOT NULL with a creation
default — and include a stable tiebreaker in both the ORDER BY and the cursor.

---

#### B22 — Thread pagination keysets on `id` while ordering by a timestamp [converged]

**Severity:** High · **Location:** `src/database/repositories/message.repository.ts:202`

**Why it breaks.** The sort column and the cursor column are different. Messages inserted out of
chronological order — exactly what backfill produces — sort into a position the `id`-based cursor has
already skipped past, so they are silently omitted from every page. The user sees a conversation with holes
in it.

**Fix.** Key the cursor on the same expression the ORDER BY uses, with `id` as tiebreaker:
`(sent_at, id) < ($1, $2)`.

---

### 4.5 Deploy, rollback and enforcement

---

#### B23 — `pnpm db:revert` is unguarded and its `down()` drops every table

**Severity:** High · **Location:** `package.json:35`,
`src/database/migrations/1756000000000-InitialSchema.ts:734`

**Why it breaks.** The documented rollback verb has no guard — `scripts/db.ts` protects only `drop`
(line 121) and `sync` (line 136). An operator undoing a bad deploy with production credentials in the shell
drops all 25 tables in one committing transaction. The `down()` is also wrong: `up()` creates 26 tables
including `oauth_states`, and `DROP_ORDER` omits it, so after a revert the next `db:migrate` aborts on
`42P07 relation "oauth_states" already exists` inside `transaction: 'all'` and the database is left
permanently un-migratable.

**Fix.** Guard `revert` like `drop`, and assert on the *resolved* host and database name — an allowlist of
local hosts and a `_dev`/`_test` suffix — not on the `NODE_ENV` label. Add `oauth_states` to `DROP_ORDER`.
Document that for the initial schema, rollback is restore-from-backup, not `db:revert`.

---

#### B24 — Every `db:*` script hardcodes `--env-file=.env.dev`, and the shell wins

**Severity:** High · **Location:** `package.json:36`

**Why it breaks.** Node lets exported environment variables override `--env-file`. A developer who exported
production `DB_*` values earlier in the same terminal, then runs `pnpm db:reset`, passes
`assert-not-prod.js` (which sees `NODE_ENV` unset, then `dev` from the file) while `DB_HOST` and `DB_NAME`
stay pointed at production. The drop succeeds, and the subsequent migrate and seed make it look like a
normal run.

**Fix.** Assert on the resolved target rather than the label, take the env file as a parameter instead of
hardcoding it, and require an explicit `--yes-i-mean-<dbname>` for destructive verbs.

---

#### B25 — The runtime image cannot run migrations, so the mandated deploy order is not executable

**Severity:** High · **Location:** `Dockerfile:24`

**Why it breaks.** `.dockerignore:9` excludes `scripts`, `tsconfig.build.json` keeps them out of `dist`, and
`tsx` is pruned — so there is no way to run migrations from the image the design doc
(`backend-design.md:920`) says must run them first. Meanwhile every replica answers 503 on `/health/ready`
because `HealthService.migrationsUpToDate()` reports pending migrations, so the deploy never takes traffic.
The only escapes are pointing a laptop at production (see B24) or enabling boot-time migrations, which races
across replicas. Seeding has the same problem: without it, `instantiateSystemRoles` finds no system roles and
the very first signup fails.

**Fix.** Add compiled entrypoints under `src/` — e.g. `src/database/cli/migrate.ts` and
`src/database/cli/seed.ts` — so `node dist/database/cli/migrate.js` exists in the image, and make those the
migration and seed job commands. Keep `scripts/*.ts` as the developer CLI.

---

#### B26 — The inbox path has zero automated tests [backlog §1.1]

**Severity:** High · **Location:** `test/`, `docs/backlog.md:21`

**Why it breaks.** The branch names this as its own top-priority defect and has since stacked eight more
inbox commits on top of it. Webhook HMAC verification — the only authentication on a public write
endpoint — is untested, so a change to body parsing that breaks `rawBody` would 401 every Meta delivery with
a green suite; after sustained non-2xx, Meta disables the Page subscription and the inbox silently stops
filling. Eleven of the confirmed findings in this review are in inbox code, more than any other area.

**Fix.** The backlog already contains the recipe as a table (`docs/backlog.md:31-37`). Land it: signed,
unsigned and replayed webhook; projection into conversation + customer + message; the reply transaction;
relay settlement; and the idempotent retry returning the original message.

---

## 5. Medium findings

109 confirmed, grouped by theme.

### Ledger and workers

| Location | Issue |
| --- | --- |
| `inbound-event.repository.ts:153,177` | Inbound settlement and terminal writes are not lease-fenced, unlike the outbound relay — a slow worker can resurrect or overwrite a row another worker owns |
| `inbound-event.repository.ts:199` | The reaper never dead-letters, so an event that kills its worker is reclaimed forever with no backoff |
| `outbound-relay.worker.ts:59` | A settlement write that throws abandons the rest of the claimed batch, leaving rows leased until expiry |
| `outbound-relay.worker.ts:178` | `settleAsFailed` writes two repositories with no transaction; its own comment says the two must not diverge |
| `backfill.worker.ts:109` | One batch-wide lease for work processed serially, guaranteeing expired leases for the tail of every large batch |
| `backfill.worker.ts:256` | A partially-walked job is left in `running`, a status no worker can claim — it resumes only via the reaper |
| `backfill.worker.ts:458` | `refresh_post_metrics` requests no metric fields on Facebook: it walks the whole post history daily and refreshes nothing |
| `backfill.worker.ts:642` | The nested messages edge is capped at 50 per thread and silently truncated — no warning, no paging |
| `backfill.worker.ts:790` | The daily metrics refresh appends one `inbound_events` row per post per day, with no retention |
| `backfill.worker.ts:600,607` | Backfill writes customer rows directly, contradicting its own "appends to inbound_events only" contract, and writes names raw while projectors normalize them — so one person gets two display names |
| `queue-listener.service.ts:108` | A `LISTEN` failure after connect leaks the pg client; a hung `LISTEN` leaves the listener dead with no reconnect |
| `queue-gauge.worker.ts:46` | `deadLettered` is cumulative, so one poison message pins the gauge at WARN forever |

### Queries, indexes and schema

| Location | Issue |
| --- | --- |
| `schema-objects.ts:609` | The three paginated list indexes cannot serve their queries' ORDER BY — every inbox, posts and customers page sorts the whole tenant |
| `schema-objects.ts:214` | `provider_connections` uniqueness keys on `provider_user_id`, so one tenant can hold two channel rows for the same Page |
| `customer.repository.ts:264` | Adding handle matching to customer search defeats the trigram index the comment says it uses |
| `customer.repository.ts:435` | `findIdByIdentifier` omits `status='active'`, so it cannot use `customer_identifiers_value_uniq` and its `LIMIT 1` is nondeterministic |
| `customer.repository.ts:312` | A stale Instagram handle is returned forever after a rename |
| `session.repository.ts:66`, `verification.repository.ts:176` | Both retention sweeps use predicates no index can serve, despite a comment claiming one was fixed |
| `queue-metrics.repository.ts:38` | Queue gauges sequentially scan three unbounded ledger tables every 60 s and on every `/health/detail` |
| `InitialSchema.ts:750` | `down()` omits `oauth_states`, so a revert leaves the database un-migratable |

### Auth, sessions and onboarding

| Location | Issue |
| --- | --- |
| `session.repository.ts:47` | Nothing ever revokes a session — `revokeAllForIdentity` has zero callers, and setting a password does not invalidate other sessions |
| `auth.service.ts:172` | Accepting a second business's invitation silently resets the person's existing global password |
| `auth.controller.ts:151` | An unauthenticated caller can permanently burn any employee invitation with five wrong codes |
| `auth.service.ts:101` | Authentication events produce neither an audit row nor a distinguishable log line, so credential attacks are undetectable |
| `verification.repository.ts:42` | A second business inviting the same person supersedes the first invitation, stranding the first employment forever |
| `verification.repository.ts:55` | A concurrent verification issue raises an untranslated `23505` and returns 500 `INTERNAL_ERROR` |
| `employees.service.ts:143` | The verification that makes an account usable is issued after the transaction commits, leaving unrecoverable orphans |
| `employees.service.ts:74` | `POST /employees` accepts any string as an email address — no format validation anywhere on the path |
| `platform-admin-bootstrap.service.ts:58` | Bootstrap hijacks an existing business identity when the configured credential collides |
| `app.module.ts:54` | Auth endpoints share the generic 120 req/min bucket; the documented tighter `/auth/*` buckets do not exist. The in-memory store also never evicts, scales the limit by replica count, and resets on every deploy |
| `role.repository.ts:42` | System-role grants are copied once at signup and never reconciled, so a permission added in a later release never reaches an existing tenant |

### Meta integration and ingestion

| Location | Issue |
| --- | --- |
| `meta-webhook.service.ts:149` | No per-item error isolation: one unstorable payload 500s the whole delivery, permanently |
| `meta-webhook.service.ts:227` | A live Facebook post event is routed to the comment projector and discarded, so posts published after connect never reach the posts table |
| `comment-normalizer.ts:154` | Comment edits and deletions are ingested, then silently discarded — the inbox never updates or removes a comment |
| `graph-api.client.ts:477` | Every Graph response is `parsed as T` with no runtime validation — external JSON typed as if trusted |
| `meta-connection.service.ts:141` | The connect transaction is held open across a Graph HTTP call and an unbounded page loop |
| `meta-connection.service.ts:191` | An Instagram child channel is created active even when its parent Page arrived with no token |
| `meta-connection.service.ts:289` | Webhook subscription is attempted once at connect and never retried or reconciled |
| `meta-connection.service.ts:306` | A non-Error value passed as `err` makes the custom serializer emit an empty object, discarding the failure reason |
| `main.ts:40` | The webhook route is exempt from rate limiting and uses the 1 MiB global cap; `MAX_WEBHOOK_BODY_BYTES` is declared and never applied |

### API contract, validation and observability

| Location | Issue |
| --- | --- |
| `inbox.controller.ts:154` | None of the six `/conversations` routes validate `:refId`, so a malformed value is a 500 **[backlog §1.5]** |
| `inbox.service.ts:315` | A malformed pagination cursor reaches Postgres and 500s on `/conversations`, `/posts`, `/customers` and `/platform/enterprises` |
| `inbox.controller.ts:171` | `GET /conversations/:refId` returns raw repository rows carrying internal bigserial ids |
| `inbox.controller.ts:175` | The new thread pagination is off-envelope: it lands in `data.pagination`, not `meta.pagination`, and omits `limit` |
| `main.ts:83` | The generated OpenAPI document describes no request field, no response and no error shape; `nestjs-zod` is a dependency with zero usage |
| `catalogue.service.ts:91,97` | Three divergent copies of `clampLimit`/`encodeCursor`/`decodeCursor`; the "opaque" cursor is plain base64 of the internal row id |
| `inbox.controller.ts:86,97` | The SSE stream authorizes once at connect and runs forever with no re-check and no maximum lifetime; an open stream also blocks graceful shutdown indefinitely |
| `inbox-events.service.ts:53,138` | The LISTEN connection is started fire-and-forget so a pg client can outlive `app.close()`, and leaks on every post-connect LISTEN failure |
| `logger.config.ts:94` | The `*.code` redact path censors `err.code` out of every error log while missing an OTP code nested deeper — it redacts the wrong thing in both directions |
| `logger.config.ts:103` | Any URL containing the substring `/health/` suppresses its access log entirely |
| `inbound-event.repository.ts:115` | The webhook's correlation id is written to `inbound_events` then thrown away — no worker log line can be joined to its originating request |
| `queue-gauge.worker.ts:12` | No counters, timers or gauges exist for any flow; logs are the only telemetry |
| `health.service.ts:98` | Health checks swallow their errors while claiming the reason is logged elsewhere; it is not |
| `schema-objects.ts:753` | The `audit_logs` append-only REVOKE is gated on a Postgres GUC (`wouchh.app_role`) that nothing in the repo ever sets — the control is inert in every environment including prod |
| `env.schema.ts:37` | `JWT_ACCESS_TTL` is accepted as any string, so a typo boots cleanly and 500s every login |
| `package.json:31` | No CI configuration exists, so typecheck, lint, tests, `db:check` and the schema-parity gate enforce nothing **[backlog]** |

---

## 6. Low findings

93 confirmed. The ones worth acting on:

| Location | Issue | Fix |
| --- | --- | --- |
| `customer.repository.ts:486` | `linkIdentifier` always returns false — `INSERT … DO NOTHING` with no `RETURNING` reports 0 affected | Add `RETURNING id` |
| `message.repository.ts:168` | Outbound messages never reach `delivered` and never show `sending` | Wire the two states or delete them from the enum |
| `InitialSchema.ts:95` | `employee_kind` defaults to `'enterprise'`, which is not a member of `EmployeeKind` | Correct the default |
| `schema-objects.ts:291` | Six foreign keys are single-column where a composite tenant-routed key exists, leaving cross-tenant rows representable | Make them composite |
| `inbound-projector.worker.ts:139` | Hardcoded `maxAttempts=3` while the row's `max_attempts` drives dead-lettering — raising the row value produces a zero-backoff retry loop | Read the row's value |
| `inbound-projector.worker.ts:141` | Projection failures are logged without the error or its stack | Log `err` |
| `workers/main.ts:24` | No bootstrap error handling; neither process registers `unhandledRejection`/`uncaughtException` | Mirror the API entrypoint |
| `workers.module.ts:56` | `InboxEventsService` is instantiated in the worker process, holding a permanent idle LISTEN connection it never uses | Scope it to the API module |
| `platform-admin-bootstrap.service.ts:71` | The admin's email is logged in clear on every boot, while the mobile beside it is masked | Mask both |
| `request-context.middleware.ts:22` | The correlation id is client-supplied and is the anchor audit rows and ledger rows are filed under | Accept as a trace hint; generate the audit key server-side **[backlog §1.6]** |
| `all-exceptions.filter.ts:144` | The http-errors branch shadows the `HttpException` branch, discarding diagnostic bodies and mislabelling 5xx | Reorder the branches |
| `all-exceptions.filter.ts:213` | `FRAMEWORK_STATUS_CODE` breaks the documented "one code always means one status" invariant | Split the code or the invariant |
| `health.controller.ts:59` | `/health/detail` exposes platform-wide operational data behind a per-tenant permission | Gate on platform admin |
| `health.service.ts:96` | `HealthService` bypasses the repository layer and queries the DataSource directly | Route through a repository |
| `comment-projector.service.ts:155` | Both projectors always write `conversations.post_id = null`, discarding the post link they already hold | Persist it |
| `inbox.controller.ts:62` | `assignedToMe=true` silently returns the entire inbox for a staff actor | Return empty or reject |
| `inbox.controller.ts:63` | Page size hardcoded as `50` instead of `DEFAULT_PAGE_SIZE` | Use the constant |
| `inbox.controller.ts:242` | `POST /conversations/:refId/read` is the one mutation with no request schema at all | Add one |
| `inbox.controller.ts:104,107` | The SSE error body is hand-built with an off-catalogue code and no `meta`, behind a blanket catch that mislabels any failure | Use the envelope |
| `employees.service.ts:214` | An employee can be moved `invited → active`, bypassing the invitation entirely | Enforce the transition |
| `employees.service.ts:176` | `POST /employees` always reports `emailVerified`/`mobileVerified` false, even for a reused verified identity | Read the identity |
| `graph-api.client.ts:169` | Pages are subscribed to a hardcoded field list that omits Instagram's comments field | Derive from platform **[backlog]** |
| `meta-connection.service.ts:85` | `handleCallback` is a ~147-line god method covering eight concerns | Split along the eight seams |
| `connections.controller.ts:214` | The controller queries two repositories and builds a join itself, bypassing `ConnectionsService` | Move into the service |
| `auth.controller.ts:254` | Auth, Enterprises and Employees controllers read repositories directly | Move into services |
| `signup.contract.ts:24,31` | `websiteUrl` accepts any scheme then is silently discarded; `timezone` and `country` are shape-checked but never validated against IANA / ISO 3166 | Validate or drop the fields |
| `conversation.repository.ts:229` | Conversation status accepts any transition, and archiving erases `resolved_at` | Add a transition table |
| `conversation.repository.ts:236` | `markRead` clears the badge and marks messages read in two unrelated autocommit statements | One transaction |
| `customer.repository.ts:400` | `nameByIdentifier` re-fires on every backfill pass for handle-only customers, writing and logging each time | Skip when unchanged |
| `audit.service.ts:74` | The audit-failure log omits every field needed to reconstruct the lost row | Log the payload |
| `inbox-events.service.ts:104,110` | `streamCount()` has no callers, the response contract schemas are dead and already drifted, and the service is a line-for-line copy of `QueueListenerService`'s connection lifecycle | Extract one listener base; delete or wire the dead code |
| `package.json:40` | `openapi:export` points at `scripts/export-openapi.ts`, which does not exist | Write it or drop the script |
| `Dockerfile:2` | The build's base image is a floating tag, contradicting the repo's own pinning policy | Pin by digest |
| `docker-compose.yml:26` | The Postgres healthcheck names a database that does not exist and can report healthy before init scripts run | Correct the name |
| `enterprise-onboarding.service.ts:91` | Signup holds row and unique-index locks on the freshly inserted `enterprises` row across an argon2 hash | Hash before the transaction |
| `data-source.ts:54` | No `lock_timeout` and no `idle_in_transaction_session_timeout`, so a stalled transaction can pin a pooled connection indefinitely | Set both |
| `main.ts:32` | Authenticated tenant-scoped responses carry no `Cache-Control` or `Vary`, and Express emits a weak ETag for each | Set `Cache-Control: private, no-store` |
| `limits.ts:111` | The SSE per-tenant stream cap is per-instance, so it is neither a real tenant guardrail nor a fair one | Move the cap to shared state or document the limitation |

---

## 7. Cross-cutting patterns

These explain clusters of findings and are the most useful part of the review.

**1. Lease fencing was invented once and then not applied.**
`markSent` carries `AND lease_owner = $4` and is correct. Its three siblings — `cancel`, `markFailed`, and
every inbound settle — do not. Every unfenced write is a duplicate send or a lost update waiting for the
right timing. The fix is not six patches; it is a rule that every write settling a claimed row goes through
one fenced helper returning an affected count that callers must check.

**2. Keyset pagination is hand-written per repository, and each copy has a different bug.**
One compares against a nullable column, one keysets on a different column than it sorts by, one base64s the
raw row id and calls it opaque, and three services carry divergent copies of `clampLimit`/`encode`/`decode`.
None of the three list ORDER BYs has an index that can serve it. One missing abstraction, five findings.

**3. Idempotency is a database guarantee on the way in and a suggestion on the way out.**
Ingestion is genuinely well done — `inbound_events_dedup_uniq`, `ON CONFLICT DO NOTHING`, a duplicate
answered 200. The reply path, the only write that reaches a customer, has an *optional* client-supplied key,
no unique index, a lookup unscoped by conversation, and a 409 where the contract promises the original
message. The strength on one side makes the gap on the other easy to miss.

**4. Meta's payload semantics are assumed rather than checked.**
`parent_id` is treated as a comment id when Meta sets it to the post id; Graph responses are `parsed as T`
with no runtime validation; the Page's own comments are not filtered out; edits and deletes are ingested and
dropped. Each is small; together they are why the inbox will look wrong on the first busy post. A zod schema
at the Graph boundary would have caught most of them.

**5. The operational story is written down but not executable.**
`backend-design.md:920` mandates migrations-then-code and says migrations never run on boot. The code honours
the boot half exactly (`migrationsRun: false`, readiness gated on pending migrations). But the image has no
migration entrypoint, `db:revert` is unguarded and its `down()` is broken, the seed is unreachable so the
first signup would fail, and no CI exists to enforce any of it. The design is right; nothing makes it true.

**6. Accountability inputs are attacker-controlled.**
The correlation id that anchors audit rows and ledger rows comes from a request header. So does the IP
written into `audit_logs` — and a non-IP value silently destroys the row. Meanwhile staff impersonation into
a customer's tenant writes no audit row at all. The audit trail is the control that matters most for a vendor
with access to customer inboxes, and it is the one built on untrusted input.

**7. Defect density tracks test coverage almost exactly.**
The inbox — the newest code and the only major surface with no tests — produced more confirmed findings than
any other area (15 from the inbox dimension alone). Auth, schema and the ledger, which have integration and
e2e coverage, produced far fewer and milder ones. This review found the bugs the missing tests would have.
Writing those tests is not hygiene here; it is the cheapest defect detection available.

---

## 8. Checklist gate

Per `/pr-review`: **any P0 failure blocks merge.** 16 P0 sections fail.

| # | Section | Verdict | Evidence |
| --- | --- | --- | --- |
| 0 | PR hygiene | **FAIL P1** | No PR body, no risk level, no testing evidence, no rollout or rollback note. Branch name does not state scope. 12 of 34 commits only fix earlier commits on the same branch |
| 1 | Architecture & layering | Partial | Layering is genuinely observed; exceptions are controllers reading repositories directly and the relay orchestrating multi-repository writes with no service |
| 2 | Validation & idempotency | **FAIL P0** | Reply idempotency optional and unscoped; six `/conversations` routes do not validate `:refId`; malformed cursor 500s; `POST /employees` accepts any string as email |
| 3 | Endpoint security & access control | **FAIL P0** | Invite→owner escalation; lockout after password verify; staff identity trusted from JWT; no session revocation; auth on the generic throttle bucket |
| 4 | Backward compatibility & contract | **FAIL P0** | OpenAPI describes no request, response or error shape; `openapi:export` points at a missing script; raw repository rows with internal ids returned; thread pagination off-envelope |
| 5 | Business-logic correctness | **FAIL P0** | Comment threading merges all commenters; Page's own comments become customers; Mention replies sent as DMs; conversation status accepts any transition |
| 6 | Data model & database | **FAIL P0** | Three list indexes cannot serve their ORDER BY; `down()` unrunnable; single-column FKs leave cross-tenant rows representable |
| 7 | Performance & scalability | **FAIL P1** | Gauges scan three unbounded tables every 60 s; backfill truncates at 50 with no paging; retention sweeps unindexed |
| 8 | Caching & Redis | **FAIL P0** | No Redis by design, but the in-memory throttler never evicts, scales the limit by replica count and resets each deploy; SSE registry has no expiry tied to the token that authorised it |
| 9 | Concurrency & distributed behaviour | **FAIL P0** | Unfenced settle writes; reaper re-queues `sending`; attempt counters count claims; opposite lock ordering in the projector |
| 10 | Error handling & reliability | **FAIL P0** | Post-send failure re-queues a delivered message (B1); no per-item webhook isolation; health checks swallow errors |
| 11 | Observability & logging | **FAIL P0** | Admin email logged in clear; correlation id client-supplied; impersonation unaudited; no metrics of any kind; `err.code` redacted away |
| 12 | Testing | **FAIL P0** | Zero coverage of webhook, projection, reply and relay; no CI, so "CI passes" is unenforceable; schema-parity gate never runs |
| 13 | Code quality | Partial | Comments are unusually good. Against that: three god methods, duplicated cursor logic, a duplicated LISTEN lifecycle, dead `streamCount` and drifted contract schemas |
| 14 | Release & rollout readiness | **FAIL P0** | No rollout mechanism, no deployment manifest, no migration job, no runbook. `db:revert` unguarded and destructive |
| 15 | Hardcoding vs configuration | **FAIL P0** | Committed superadmin password and app secret; throttle policy, page size and subscription field list hardcoded; token-encryption placeholder unguarded in prod |
| 16 | Query correctness & safety | **FAIL P0** | NULL-unsafe cursor; keyset column ≠ sort column; `markFailed` WHERE too broad; nondeterministic `LIMIT 1` |
| 17 | Query performance | **FAIL P0** | Every paginated list sorts the whole tenant; trigram index defeated by the handle match; two unindexed retention sweeps |
| 18 | Locking, transactions, concurrency | **FAIL P0** | READ COMMITTED throughout and mostly safe — most find-or-create paths are correctly constraint-backed. Fails on a transaction spanning a Graph HTTP call, opposite lock ordering, and no `lock_timeout` or `idle_in_transaction_session_timeout` |
| 19 | Schema & migrations | **FAIL P1** | Single initial migration, so expand/contract is untested. `down()` broken; parity gate never runs; backlog records the migration as knowingly drifting from the entities |
| 20 | Query operational | **PASS** | `statement_timeout` set and validated against the request timeout at boot; `57014` mapped to a clean 504; pool bounded by `DB_POOL_MAX` |

**P0 verdict: FAIL — do not merge.**

---

## 9. Claims that did not survive verification

Every finding was handed to an adversarial verifier instructed to refute it. Eleven fell. Listed because a
review that never rejects anything is not a review.

**"Staff roles are seeded but never consulted, so every staff actor gets the full permission union in every
enterprise."** Descriptively accurate but the failure is unreachable. The only writer of `staff_members`
creates rows with `hasAllEnterpriseAccess: true` and re-upgrades any downgraded row; every path that mints a
staff-kind token gates on that flag; and any staff person who also has an employment resolves through the
employee branch, which does join `employee_roles → role_permissions`. What survives is narrower and was
recorded as low: the `support` and `ops` templates are structurally unassignable dead configuration, because
`employee_roles.enterprise_id` is NOT NULL and those templates are NULL-enterprise.

**"No customer merge exists, so one person on Facebook and Instagram is permanently two customers."** A
documented scope decision, not a defect. `docs/schema.md:1133` states `merged_into_customer_id` is a forward
seam nothing sets in V1, and `:1995` lists identity merging as explicitly out of scope. The read-side filter
cited as evidence of a missing path *is* the seam. There is also no technical means to link a Facebook PSID
to an Instagram-scoped id from the payloads this service receives.

**"OAuth connect is never audited, so there is no way to know who connected a Page."** The line immediately
above the quoted evidence passes `connectedByEmployeeId`, sourced from the `oauth_states` row rather than the
token, and the repository persists it to a column with a composite FK. The acting employee is durably
queryable. There is also no disconnect flow in the codebase to leave unaudited. What survives is only that no
`audit_logs` row is written on connect — a real but minor gap.

**"The OAuth callback transaction spans an unbounded page loop the request timeout cannot cancel."** The
load-bearing mechanism is false: the callback carries `@SkipTimeout()`, with a comment explaining that being
aborted halfway is the worst available outcome. The transaction-across-HTTP concern is real and was kept
separately as a medium; the timeout framing was not.

**"Migrations require CREATE EXTENSION privileges no runbook establishes."** Both `pgcrypto` and `pg_trgm`
are marked trusted on PostgreSQL 18, the version `docker-compose.yml` pins, so an ordinary database owner can
create them.

**"`.env.dev` points at port 5432 instead of compose's 5544, so destructive scripts hit the developer's real
database."** Read backwards. `README.md:21-22` states the policy directly: compose is optional, and a local
PostgreSQL on 5432 is what the default `.env.dev` deliberately targets.

**"The hourly per-destination verification cap is a count-then-insert with no constraint."** The TOCTOU shape
is real, but the realistic burst case is already serialised by the index the reviewer dismissed.

Four further claims were refuted on similar grounds: a missing `updated_at` trigger that exists, a
`headersSent` check that is unnecessary on the SSE route, conversation-status transition rules counted twice,
and two formatting-only commits misread as behavioural.

---

## 10. What to do first

### Before this ships — blocking, roughly 2–3 days

1. **B1** — move the settlement write out of the send `try` and add `AND status <> 'sent'` to `markFailed`.
   Two lines; stops customers receiving duplicate replies.
2. **B2, B3** — fence `cancel` and `markFailed` on `lease_owner`; stop the reaper reclaiming rows in
   `sending`. Same defect family as B1.
3. **B7, B8** — refuse role grants above the caller's own permission set; move the lockout check before
   password verification.
4. **B23, B24** — guard `db:revert`, assert on the resolved host and database name rather than `NODE_ENV`,
   and add `oauth_states` to `DROP_ORDER`.
5. **B9, B10, B11** — remove the committed admin password and app secret, clear the `skip-worktree` bit,
   extend the prod refinement over `TOKEN_ENCRYPTION_KEY_K*`, and rotate anything that has been shared.
6. **B16** — fix comment threading. Without it the inbox is wrong on any post with two commenters, which is
   most of them.
7. **B25** — add compiled migrate and seed entrypoints, or the first deploy cannot become ready and the first
   signup fails.

### Next sprint — roughly 1–2 weeks

1. **B26** — land the inbox test suite. The recipe is already in `docs/backlog.md`. Start with the webhook
   signature cases, since that is the only auth on a public write endpoint.
2. **Add CI.** Every gate currently passes and nothing keeps it that way. Wire typecheck, lint, format, all
   three suites, `db:check` and `pnpm test:schema`, and make `SCHEMA_PARITY` the default rather than opt-in.
3. **B21, B22** and pattern 2 — extract one keyset-pagination helper, fix the NULL and column-mismatch bugs in
   it once, and add the three covering indexes.
4. **B17, B18, B19, B20** — the remaining inbox correctness set: filter the Page's own comments, dispatch
   replies on parsed thread kind, use `GREATEST` for the window timestamps, make the idempotency key required
   and constraint-backed.
5. **B13, B14, B15** — re-read the staff row per request, wire `revokeAllForIdentity` into suspension and
   password change, audit impersonation, and validate the forwarded IP in the middleware.
6. **B5, B6** — count failures rather than claims, and make `paused` resumable, before any real backfill runs.

### Worth doing — as capacity allows

1. Validate Graph responses with zod at the boundary instead of `parsed as T`; most Meta-integration findings
   collapse into that one change.
2. Give the API a real contract: adopt `nestjs-zod` (already a dependency, currently unused), declare
   responses, commit the OpenAPI document and diff it in CI.
3. Replace the in-memory throttler before running a second replica — today the limit multiplies by replica
   count and resets on deploy.
4. Add metrics for queue depth and lag, send success and failure, Graph error rates and auth failures. Logs
   are currently the only telemetry.
5. Set `lock_timeout` and `idle_in_transaction_session_timeout`, and give workers their own pool as the design
   doc already specifies.
6. Refresh `docs/backlog.md` — five items it lists as open are fixed (including §1.4, OAuth state single-use,
   which is now correctly implemented), and README's "what does not work" lists two features that now do.

---

## 11. Change summary

**Description.** The complete wh-api-unified-service: auth and onboarding, Meta OAuth and webhook ingestion,
a Postgres-backed event ledger with seven workers, the social inbox with SSE, employees with roles and
permissions, a platform-admin console, backfill, and posts/customers endpoints. 34 commits, 252 files,
+40,289 lines, against an effectively empty `main`.

**Impact: P0.** 16 P0 checklist sections fail. One critical defect duplicates customer-visible messages; two
defeat authentication controls; one makes the documented rollback destroy the database.

**Key concerns.** Duplicate sends from unfenced ledger settlement (B1–B3); privilege escalation through invite
and a lockout that never triggers (B7, B8); committed superadmin and Meta credentials (B9, B11); comment
threading that merges every commenter on a post into one conversation (B16); pagination that silently drops
rows on three endpoints (B21, B22); an unexecutable deploy and an unguarded destructive rollback (B23–B25);
and zero test coverage over the entire inbox path (B26).

**Testing evidence.** Typecheck, lint, format, 81 unit, 27 integration (1 skipped) and 51 e2e all pass against
local PostgreSQL 18 — verified in this session, not taken on trust. The schema-parity gate never runs, and no
CI configuration exists, so none of this is enforced. The inbox, ingestion, projection, reply and relay paths
have no automated coverage at all.

**Rollout plan.** Does not exist. No CI, no deployment manifest, no migration job, no feature-flag surface
beyond boot-time env booleans. `backend-design.md:920` states the intended order — migrations, then code,
never on boot — and the code honours the boot half, but the image cannot run migrations, so the order is not
executable.

**Rollback plan.** Unsafe as written. `pnpm db:revert` is unguarded and drops all 25 tables; its `down()`
omits `oauth_states`, leaving the database un-migratable afterwards. Since `main` is empty there is no
previous image to roll back to, so real recovery is restore-from-backup — which no document mentions.

**Final verdict: do not merge yet.** The architecture is sound and much of the hard thinking is already done
well — this is not a rewrite. But the P0 set is real, and four items in it cost either customer trust or data.
Fix the "before this ships" list, then merge; the rest is tractable follow-up work.

---

## 12. Method and limits

**Method.** Two workflows, 78 agents. Three recon agents mapped architecture, data model and runtime flows;
21 dimension reviewers worked those maps plus the source; 51 adversarial verifiers were told to refute every
finding and were given the file to check it against; a completeness critic hunted for what the dimensions
missed. 307 findings raised, 11 refuted with counter-evidence, 42 downgraded to plausible.

**Dimensions reviewed.** architecture-layering, authn-authz-tenancy, input-validation,
security-crypto-secrets, schema-migrations, query-correctness, concurrency-ledger,
error-handling-resilience, business-logic-state, meta-graph-integration, inbox-working-tree,
api-contract-compat, observability-logging, testing-quality, config-deploy-release, code-quality-types,
pr-hygiene, caching-redis, transactions-locking-isolation, ops-rollout-runbook, contract-idempotency-tests.

**Limits.**

- 42 low-severity findings were not independently verified and are excluded from the confirmed counts.
- No `EXPLAIN` was run against production-shaped data, so index claims are read from the migration rather
  than measured.
- Line numbers are against `eefbeda`. Two commits (`d5292d5`, `eefbeda`) landed while the review was running;
  reviewers read the working tree, which matched what those commits contain.
- Nothing has been posted to a pull request.
