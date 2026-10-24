# SOP — building anything in this service

The checklist to work through for any new endpoint, worker, or change to an
existing one. **Bullets only.** Every "why" lives in
[`backend-design.md`](./backend-design.md) (the code) or
[`schema.md`](./schema.md) (the data), and is linked rather than repeated —
two copies of a rule disagree eventually.

Work down it in order. The order is the build order: the contract before the
code, the guards before the logic, the record before the response.

**Checkpoint 20 is not optional.** An architectural decision that is not written
into the design docs is a decision that will be re-taken, usually by someone who
does not know it was ever decided.

---

## 0. Before you write anything

- [ ] Read [`backlog.md`](./backlog.md) — the thing may already be known-broken or already planned.
- [ ] Read [`platform-limitations.md`](./platform-limitations.md) if it touches Meta data. Do not go looking for something the platform does not give us.
- [ ] Check [`backend-flows.md`](./backend-flows.md) §20 for what is designed but **not built**. Promise nothing from it.

---

## 1. The contract comes first

- [ ] Request schema is a Zod `strictObject` in `src/shared/contracts/<module>/`. Unknown keys are **rejected**, not ignored.
- [ ] Types are **inferred** from the schema (`z.infer`), never declared twice.
- [ ] Every field: required vs optional decided, type/format checked (uuid, email, currency), range/length bounded, enum values from `shared/enums`.
- [ ] Inputs trimmed and normalised (case, whitespace) — `shared/utils/normalize/`.
- [ ] Defaults are explicit and safe. No silent behaviour change.
- [ ] List endpoints: `limit` validated and **capped**; cursor-based for anything that grows; sort/filter fields from an allowlist.
- → detail: `backend-design.md` §9 (contracts), §8.3 (pagination)

## 2. Response shape

- [ ] Controller returns **plain data**. Never build an envelope by hand — `ResponseEnvelopeInterceptor` wraps it.
- [ ] A paginated result returns `{ items, pagination }`; the interceptor lifts `items` onto `data` and moves `pagination` into `meta`. **Without `pagination`, `items` stays nested** — this has bitten the portal before.
- [ ] Entities are never returned directly. Map entity → response in a `to*Summary` function, so `id`, `password_hash` and encrypted tokens cannot leak.
- [ ] **Numeric ids never leave the server.** Public handles are `refId`.
- → detail: `backend-design.md` §8.1, `src/shared/contracts/envelope.ts`

## 3. Authentication

- [ ] Routes are protected **by default**. A route is public only with `@Public`, and that needs a reason.
- [ ] `@Public` routes carry their own proof: webhooks verify the HMAC against the **raw body** before parsing; the OAuth callback verifies the signed, expiring state.
- [ ] Identity comes from `@CurrentScopedActor()` / `RequestContext` — **never** from a request body.
- → detail: `backend-design.md` §7.1, §7.5

## 4. Authorization — both gates

- [ ] `@RequirePermission(Permission.X)` (or `@RequireAnyPermission`) on every tenant route.
- [ ] Decide the **commercial gate**: in `catalogue.seed.ts`, `FEATURE_BY_RESOURCE` maps the resource to a `FeatureKey` or explicitly to `null`. The record is exhaustive, so a new resource without a decision is a compile error.
- [ ] `null` means "part of running the account" and must keep working with no feature active. Anything that moves money or data is **gated**.
- [ ] New permission code → added to `Permission`, `PermissionResource`, its description, and its holder population (`enterprise` / `staff` / `both`).
- [ ] New feature → `FeatureKey` + a `FEATURES` entry, so a platform admin can switch it on per business.
- [ ] Run the seed. A permission whose `feature_id` drifted is corrected by the seed's UPDATE, not by `ON CONFLICT DO NOTHING`.
- [ ] Staff reach does **not** bypass the feature gate.
- → detail: `backend-design.md` §7.2, `schema.md` §5–10, `rbac-plan.md`

## 5. Tenant scoping

- [ ] `enterpriseId` comes from the token and is passed explicitly to every repository method.
- [ ] **Every tenant-scoped write names `enterprise_id` in its `WHERE`**, even when the primary key alone would find the row. Composite FKs protect references; only the predicate protects an UPDATE.
- [ ] Resolve a `refId` scoped to the enterprise **first**, then use the numeric id internally.
- [ ] Cross-tenant reads live only in `platform-admin.repository.ts`, behind the platform gate.
- → detail: `backend-design.md` §19.6, §15

## 6. Layering

- [ ] Controller: parse → call service → map response. Nothing else.
- [ ] Business logic **only** in the service.
- [ ] Repository: queries only, no business rules. No SQL above the repository layer.
- [ ] No `SELECT *`. Explicit columns.
- [ ] Parameterised queries only — `$1`, `$2`. No interpolation, ever, including the raw escape hatch.
- → detail: `backend-design.md` §3, §5

## 7. Transactions

- [ ] Reads and validation happen **before** the transaction opens.
- [ ] One flow = one `tx.runInTransaction`. Nested calls **join** the ambient transaction — there is no implicit savepoint, so a nested call that swallows an error poisons the outer one.
- [ ] **No network I/O inside a transaction.** Write the `outbound_events` row, commit, let the relay call out.
- [ ] Idempotency is a **unique index**, not a check-then-write. Use `ON CONFLICT`.
- [ ] Guard goes in the `WHERE` clause, not in a prior `SELECT`.
- → detail: `backend-design.md` §6

## 8. Database and migrations

- [ ] Migration is hand-written SQL with a real `down`.
- [ ] **Registered in `data-source.ts`.** An unregistered migration is dead: `migrate` reports "schema is up to date" and the change never reaches any database.
- [ ] Anything the synchroniser cannot express (partial index, expression index, composite FK, CHECK, trigger, REVOKE) goes in **both** the migration **and** `schema/schema-objects.ts` — a database can be built either way.
- [ ] Expand/contract: additive migrations run **before** the code; a drop runs **after** the code stopped referencing it.
- [ ] Index every new query pattern on a hot path, `(enterprise_id, <business key>)`.
- [ ] Pagination queries have a deterministic `ORDER BY` with a stable tiebreaker.
- [ ] Large backfills are batched and throttled.
- [ ] New table added to the TRUNCATE lists in `test/integration/db.harness.ts` and `test/e2e/app.harness.ts`.
- → detail: `backend-design.md` §5.1, [`deploy-order.md`](./deploy-order.md)

## 9. Audit trail — every state change

- [ ] Anything that creates, changes, removes or withdraws writes an `audit_logs` row via `AuditService.record`, **inside the transaction** (it joins the ambient one, so a rollback takes the record with it).
- [ ] **System actions count.** A reward granted by a rule, an award reversed by a worker — recorded with `actor_kind = 'system'`. No human in the stack is the accurate answer, not a reason to skip the row.
- [ ] The actor is **never passed in**. `AuditService` reads it from `RequestContext` so a call site cannot record under the wrong name. No session (OAuth callback, signup, worker) → `system`, with whatever attribution exists in `metadata`.
- [ ] **The action must say what actually happened.** A revocation is not a grant; an unhide is not a hide. If no existing `AuditAction` is honest, add one — the enum is cheap, a misleading row is not.
- [ ] **Never** in `changes` or `metadata`: message bodies, a customer's words, email, phone, tokens, `forward_config`. A failed sign-in records *that* a credential was tried, never which one.
- [ ] Adding an enum member without the code that writes it is not coverage. Ship both in one commit.
- [ ] Not recorded: reads, no-ops, health checks, retries of something already recorded.
- → detail: `schema.md` §25, `backend-design.md` §15, §19.9

## 10. Version history — editable configuration

- [ ] If the entity's configuration decides money, access or behaviour, every change also appends via `EntityVersionService.record`.
- [ ] Audit says **who**; the version says **what it then was**, in full. A snapshot must stand alone — reconstructing March must be one row, not a replay of every diff.
- [ ] The snapshot is **stated by the call site** in one `snapshotOf` helper, never serialised from the row — a credential reference written into an append-only table can never be taken back out.
- [ ] Do not compute the diff at the call site; the service derives it from the two snapshots.
- → detail: `schema.md` §26, `backend-design.md` §19.9

## 11. Errors

- [ ] Services throw **one** type: `AppException(ErrorCode.X, { details })`.
- [ ] New code added to `ErrorCode` **and** to the status map — a status is never chosen at the throw site.
- [ ] 4xx for client, 5xx for us. `*_NOT_FOUND` 404, conflicts 409, validation 422, permission/feature 403.
- [ ] A cross-tenant read returns **404**, not 403 — existence is not disclosed.
- [ ] No stack traces, driver errors, constraint names or internal ids in a response body.
- [ ] Never swallow an error silently. If you must, the comment says why.
- → detail: `backend-design.md` §8.2

## 12. Logging and observability

- [ ] Structured, with `correlationId`. Add `enterpriseId` / `route` where known.
- [ ] **Never logged:** passwords, hashes, tokens, verification secrets, ledger `payload`, customer `display_name` / `username`, email, phone. Mask or hash where an identifier must appear.
- [ ] No `info` logging inside a per-row loop.
- [ ] A swallowed error logs everything needed to reconstruct what was lost.
- → detail: `backend-design.md` §13.2

## 13. External calls

- [ ] Timeout on every call. Retries capped, with exponential backoff **and jitter**.
- [ ] Check `reauth_required` before spending an attempt on a dead token.
- [ ] Partial failures are surfaced on the row and reported, never swallowed into a "success".
- → detail: `backend-design.md` §12, §13.4, §18.3

## 14. The portals — do not ship a backend-only feature

- [ ] **Admin console** (`admin.html`, `assets/features.js`): a new `FeatureKey` must be switchable per business, or nobody can ever turn it on. A feature nothing can toggle is not shipped.
- [ ] **Roles screen** (`assets/roles.js`): a new permission must be grantable, or no role can hold it.
- [ ] **Tenant portal**: the page for the feature itself — a field per contract field, with a `<label>` and a `.field-note` saying what it is.
- [ ] A control that cannot fire is labelled as such, not silently offered.
- [ ] Portal reads the envelope correctly — see checkpoint 2.

## 15. Tests

- [ ] **Unit** for the logic and its edge cases.
- [ ] **Integration against real Postgres** for anything that relies on a Postgres feature — a partial unique index, `ON CONFLICT`, a composite FK, a trigger. A mock accepts the duplicate the real index rejects.
- [ ] **E2E** for the route: guard behaviour, envelope shape, and the mandatory cross-tenant test — authenticate as A, request B's resource by `refId`, assert 404.
- [ ] **Negative tests**: invalid input, expired token, exhausted attempts, duplicate webhook.
- [ ] A database-level guarantee gets a test that **attempts the forbidden thing** and expects a rejection.
- [ ] A control with a threshold gets a test proving it **can fail**. A control that cannot fail is worse than none — the screen promises a ceiling nobody enforces.
- [ ] Verify against the **shipped** code path. A test that re-implements the logic proves only that the copy agrees with itself.
- [ ] Deterministic: time injected, randomness seeded, no test depending on another's leftovers.
- → detail: `backend-design.md` §16

## 16. The gate, before you commit

- [ ] `npx tsc --noEmit` — the test runner transpiles without type-checking, so this catches what vitest will not.
- [ ] `pnpm lint`
- [ ] `pnpm format` / prettier check
- [ ] `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`
- [ ] `pnpm build`

## 17. Getting it into main

- [ ] Work on a branch off `main`. **Nothing is committed to `main` directly.**
- [ ] Code reaches `main` **only through a pull request**. No direct push, no local merge, no exceptions for a one-line fix.
- [ ] **Squash merge only.** Not a merge commit, not rebase-and-merge.
- [ ] Checkpoint 16 is green **before** the PR merges, not after.
- [ ] The PR body says: what changed, why, risk level, testing evidence, and the rollout/rollback note from checkpoint 18.
- [ ] **Delete the branch as soon as it is squashed.** A merged branch left behind is indistinguishable from an abandoned one a month later.

**Why squash.** `main` becomes a list of *changes*, one commit per reviewed unit
of work, rather than a transcript of somebody's keystrokes. A revert is then one
commit, and `git bisect` lands on something that was actually reviewed and
actually passed the gate.

**The consequence to know about, because it looks alarming.** A squash merge
rewrites the branch's commits into a single new one, so the originals are never
in `main`'s history. `git rev-list main..the-branch` therefore still reports
every one of them as unmerged — a branch whose work shipped weeks ago can read
as "187 commits not in main" and look far too risky to delete. It is not: the
*content* is in `main`, only the commits are not. Confirm with the diff
(`git diff main...the-branch`) or with the PR, never with the commit count.

## 18. Release

- [ ] Deploy order: **migrate → seed → code**. Not a preference.
- [ ] Breaking change? Versioning or migration plan, or it does not ship. Removing/renaming a field, changing a type or a default, or changing an error shape are all breaking.
- [ ] Rollback plan exists and is practical.
- [ ] Risky change sits behind a feature flag or a phased rollout.
- → detail: [`deploy-order.md`](./deploy-order.md), `backend-design.md` §14

## 19. Before you call it done

- [ ] **Read it back from the database.** Configuration is not evidence of state — query for the trigger, the grant, the row, the subscription, and read the answer. Two real defects here were found that way and neither was visible in the code.
- [ ] Check which process holds `:3000` and that exactly one API and one worker are running. A stale worker claims jobs with old code and is invisible to a port check — grep the **entry path**, never the repo name.
- [ ] Report honestly: what was verified against real data, what was only unit-tested, and what was left out.

## 20. Record the decision, or it will be re-taken

**Every architectural decision goes back into the design docs, in the same
change that makes it.** Not afterwards, not in the PR description, not in a
commit message nobody will find.

This is how the reasoning survives the person who had it. These documents are
the only reason anyone can tell a deliberate choice from an accident two years
later — and a choice that reads as an accident gets "fixed" by the next person
to walk past it.

**What counts as an architectural decision:**

- [ ] A table, column, index, constraint or trigger — and *why that shape*.
- [ ] A change to layering, transactions, auth, the API contract, or background work.
- [ ] Choosing one mechanism over another that was genuinely considered.
- [ ] A rule that constrains future code ("every tenant-scoped write names `enterprise_id`").
- [ ] A deliberate limitation — something the platform will not do, or something we decided not to build.
- [ ] A reversal of an earlier decision.

**Where it goes:**

| The decision is about | It belongs in |
| --- | --- |
| The data — tables, keys, constraints | [`schema.md`](./schema.md) |
| The code — layering, transactions, auth, contract, workers | [`backend-design.md`](./backend-design.md), in the section it affects |
| Something the build taught us that the design got wrong | [`backend-design.md`](./backend-design.md) §19 |
| A feature's own design | its own doc, e.g. [`reward-programs-design.md`](./reward-programs-design.md) |
| What a platform will not give us, verified against live traffic | [`platform-limitations.md`](./platform-limitations.md) |
| A gap found and deliberately not closed | [`backlog.md`](./backlog.md) |
| A rule everyone must follow from now on | this file |

**How to write it:**

- [ ] **Record the reasoning, not just the conclusion.** `backend-design.md` says it plainly in its own opening: a design doc that only lists conclusions cannot be argued with when the conclusions age. The next person needs to know what you traded away, not only what you picked.
- [ ] **Name what you rejected and why.** "We use X" is weaker than "we use X because Y broke on Z".
- [ ] **State the honest limit.** Every control has an edge it does not cover. Write it down, so it is a known boundary rather than a surprise.
- [ ] **A reversal amends the original passage** and says what changed its mind. Never leave two documents disagreeing — the reader cannot tell which one is current, and will pick the wrong one.
- [ ] **If the defect was that a document claimed something untrue, fix the claim in the same change.** A comment asserting a guarantee is not evidence of it, and a stale assertion is worse than silence: `audit_logs` was documented as append-only for months while the application role could edit every row in it.
