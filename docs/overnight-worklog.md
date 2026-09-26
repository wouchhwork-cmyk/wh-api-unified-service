# Overnight worklog — started 21 Sep 2026

Two tasks, handed over at night with no reviewer available. This file is the
**resume point**: if the session dies, is compacted, or hits a usage limit,
start by reading this, then `git log --oneline` to see what actually landed.

**The rule for this file:** a box is ticked only when the work is committed AND
the gate is green (`pnpm lint`, `pnpm build`, `pnpm test`). Anything in progress
is described under RESUME HERE with enough detail to pick up cold.

---

## RESUME HERE

> **Current state:** Both tasks complete; five review rounds done. 794 tests,
> lint, typecheck and schema parity green. The app boots, all new routes answer,
> and the platform endpoints were checked live against the dev database.
>
> Deploy order is NOT the obvious one — see `docs/deploy-order.md`. It is
> migrations, then **seed**, then code, and the seed must run again after the
> rollout completes.
>
> What was deliberately not fixed is in `docs/todo.md` §E.
>
> **Gate:** `npx tsc --noEmit` (covers tests, which `pnpm build` does not),
> `pnpm lint`, `SCHEMA_PARITY=1 npx vitest run`.

---

## Task 1 — Meta rate-limit monitoring for the platform admin

**What was asked:** a dashboard for the *platform* admin (not a tenant admin)
showing how much of the app's Meta API allowance is spent and how much remains,
broken down per connected enterprise and per channel, refreshed on an interval,
persisted so it survives a restart and resets when Meta's window resets.

**What the research established** (docs + live probing, 21 Sep — see
`platform-limitations.md` §0.4):

- Meta runs **two separate meters** and which applies is decided by the TOKEN.
  - `X-App-Usage` — one pool for the whole developer app. Returned for app and
    **user** tokens, i.e. our OAuth/discovery path. Allowance
    `200 x daily active users` per **hour**. **Measured: 30 calls moved it 1% ->
    12%**, so the pool is on the order of 250 calls/hour. Small, shared by every
    tenant, and it does NOT grow as businesses connect.
  - `X-Business-Use-Case-Usage` — one pool **per business per product**.
    Returned for Page and Instagram tokens, i.e. the whole inbox hot path.
    **Measured: 30 calls each against pages, messenger and instagram moved them
    0%.** Roomy.
  - Meta documents that where both could apply the business meter is used
    *instead of* the app meter. **Confirmed by measurement**: 90 business-token
    calls did not move the app counter.
- **Every figure is a percentage, not a count.** Throttling starts at 100.
- A single Instagram read reports under **two** ids: the account (one of our
  `platform_channel_id`s) and the owning Meta Business.
- The same Page token reports `type: pages` on a node read and `type: messenger`
  on the conversations edge — **the same asset drains different pools**.
- `estimated_time_to_regain_access` is **not** a health signal: Meta shows 0
  against pools at 95%. It means "not blocked right now".
- Meta is explicit that **calling while throttled extends the block**.

### Design decisions, and why

- **Attribute by `platform_channel_id`, not by threading tenant context through
  23 call sites.** Meta keys the business header by the very id we already
  store. Verified live for a Page and an Instagram account.
- **Buffer in memory, flush on a timer.** A write per Graph call would put a
  round trip on every platform call. One UPSERT per pool per flush instead.
- **Counts add, percentages take the highest.** Counts are contributions and sum
  correctly across replicas with no coordination; percentages are observations
  of one global position, so summing them would be nonsense.
- **A missing header is `NULL`, never `0`.** Absence means we cannot see our
  position; reporting it as 0% would show a clear budget at the worst moment.
- **Two window sizes**, because Meta meters over two: hour for the app pool,
  24 hours for the business pools.

### Checklist

- [x] Live probe: which headers, on which calls, and how fast each moves
- [x] Documentation research (windows, formulas, codes, back-off advice)
- [x] `MetaUsageMeter` / `MetaUsageProduct` enums
- [x] Constants (bucket, flush, retention, thresholds)
- [x] `provider_api_usage` entity + registration
- [x] Migration `1758100000000-ProviderApiUsage` + registration in `data-source.ts`
- [x] `graph-usage.parser.ts` — one owner for both usage headers
- [x] `ProviderApiUsageRepository`
- [x] `MetaUsageCollector` — buffer, flush, attribution, inference
- [x] Hook into `GraphApiClient.request` (success, error and transport paths)
- [x] Widen throttle detection to the whole `800xx` range (the published code
      table disagrees with itself on 80002 vs 80005; the range does not)
- [x] `MetaRateLimitService`
- [x] Platform contract + controller endpoints
- [x] Module wiring (API **and** workers — both processes make Graph calls)
- [x] Retention sweep in `SweeperWorker`
- [x] Tests: parser (20), collector (19), repository (28), wiring (5), e2e (3)
- [x] Portal page
- [x] Commit — `e660405` and the portal commit
- [ ] `platform-limitations.md` §0.4 update with the app-meter measurements

---

## Task 2 — Role-based access control, built properly

**What was asked:**

1. An enterprise can **create its own roles**, choosing permissions from a list
   **segmented by area** (mentions -> see / reply / hide / delete / assign, and
   so on for every area).
2. **Role levels.** A manager cannot create another manager — only roles *below*
   their own level. The business defines the levels.
3. **Permission to create employees** is itself a permission.
4. When granting access to an employee, a grantor may only give a **subset of
   what they hold**.
5. **Visibility follows level**: an agent sees agents, not managers.
6. The **permission catalogue is out of date** — the product has outgrown it.
   Review and extend.
7. The **platform admin's feature-activation list** is likewise out of date.
   Review and extend.
8. **Platform-side RBAC is in scope too.**

**Standing instruction:** research and plan first; implement only after. No
reviewer is available, so I review my own work in multiple rounds.

### Checklist

- [x] Research: current RBAC — entities, guards, seeding, enforcement points
- [x] Written plan — `docs/rbac-plan.md`
- [x] **Role levels** — `01778a8`. 0-100, higher is more. Owner 100, manager 70,
      agent 40, viewer 10. Three comparisons: see `<=`, assign `<`, modify `<`.
      Rules live in `src/shared/rbac/authority.ts`, pure, 32 unit tests.
      Closed: a manager could mint another manager, and could suspend the owner.
- [x] **Visibility by level** — `d418ce5`. The listing showed the whole company
      to anybody with `employees.view`, which the agent and viewer roles hold.
      Filtered in SQL (HAVING, before LIMIT) so pages do not come back short.
- [x] **Template reconciliation (B2)** — `1fc8604`. Additive, except levels,
      which are corrected because the level IS the hierarchy. Also fixed the
      seed's `run()` returning TypeORM's `[rows, count]` tuple for UPDATE.
- [x] **Permission catalogue split** — `61b07c4`. `mentions.*` is new;
      `comments.assign/manage` fill the gap; `comments.hide/delete` are enforced
      for the first time. Closed a real feature leak: comment threads were gated
      on `unified_inbox`, so a tenant with `comment_management` REVOKED kept full
      comment access — one live tenant was in exactly that state.
- [x] **Role CRUD** — `f69322e`. Catalogue, list, create, replace, retire, and
      replacing one person's roles. 21 e2e tests, mostly refusals.
- [x] Portal: role editor UI — portal `6367899`
- [x] **Platform-side RBAC (B3)** — `64e9db5`. `staff_roles`, no enterprise_id,
      composite FK through `(role_id, role_scope)`. Behaviour-preserving for
      existing admins.
- [x] **Feature model** — `114b5a3`. The expiry sweep the index was always
      for, and the request path that made `access_requested`,
      `features.request` and `AuditAction.FeatureRequested` reachable.
- [x] **Review round 1 — escalation** — `62a014a`. Found: strict levels made
      an owner unmodifiable by anyone, so a departed founder's account was
      permanent. Owners now police each other; last-owner protection added.
- [x] **Review round 2 — isolation** — `171a051`. Every new query audited;
      `replaceRolePermissions` gained its tenant clause.
- [x] **Review round 3 — adversarial** — `87321fd`, `a60f26f`. A fresh-eyes
      pass found the one that mattered: **the subset rule ran on role
      DEFINITION and not on ASSIGNMENT**, so a manager could hand out an
      owner-made custom role carrying `enterprise.manage`. Also: the SSE stream
      was widened to `@RequireAnyPermission` and never filtered, leaking the
      existence and timing of every private thread to somebody holding only
      `mentions.view`.
- [x] **Review round 4 — the rate-limit monitor and the tests** — `2001f33`,
      `db56985`. The monitor had never been reviewed by anyone but me. Found:
      unrelated timeouts corrupting the app gauge; one refusal painting a pool
      red for 24 hours; no upper bound on a percentage, so one odd header could
      blind the monitor platform-wide; and a console query whose comment claimed
      an index scan it provably did not do (EXPLAIN showed a Sort over a CTE
      Scan). A deploy rehearsal against a database with existing data found a
      NOT NULL column that would have broken signup mid-rollover — and the first
      fix for it silently set every existing role to level 0.
      A test-quality audit found four security-critical paths with no coverage
      at all and five assertions that could not tell which rule had fired.
- [x] **Review round 5 — verifying round 4** — `22bfc1e`. The headline fix from
      round 4 was COSMETIC: headerless calls were moved off the `app` scope key
      and left on the `App` meter, and the console groups by meter. The bug was
      untouched and the tests agreed with the commit message because they
      asserted the key and never the meter.
- [x] **Review round 3b — verifying the fixes** — `87e9d7f`. Caught a blocker I
      had just introduced (the comment projector announced every MENTION as a
      comment thread, breaking the new filter in both directions) and a race the
      owner-peer rule had made reachable (two owners demoting each other
      concurrently could leave a business with none). The fan-out decision is a
      pure function with tests now — nothing had tested it through two defects.

### Decisions worth not re-litigating

- **Levels are spread (100/70/40/10), not dense.** A business can insert
  `Senior agent` at 55 without renumbering.
- **An employee's level is the MAX of their roles**, never the min — taking the
  min would mean granting an extra role silently demotes somebody, which is
  itself an attack.
- **The subset rule checks GRANTED codes, not feature-gated ones.** A business
  whose inbox subscription lapsed should still be able to edit a role that
  mentions inbox permissions; the gate applies independently at use time.
- **Mentions ride on `unified_inbox`, not a new feature.** A new feature would
  break every existing tenant the moment it shipped.
- **Staff actors get the owner's level for reads and are refused writes.** They
  have no employment, so a write would record "somebody" in the audit trail.
- **A conversation you may not see is 404, not 403.** A 403 confirms the refId
  exists, and a refId is the only handle a client has.

---

## Standing constraints for this session

- No `Co-Authored-By:` or any Claude/Anthropic attribution in commits.
- Never push. Commit only.
- Never inject synthetic webhook deliveries into the dev database.
- Migrations are expand/contract and must be registered in `data-source.ts`.
- Tenant isolation must not be bypassable; escalation paths are the thing to
  hunt for in review.
