# Todo

The working checklist. `docs/backlog.md` holds the reasoning and the evidence;
this holds the order and the state, so "what is left" is one glance rather than
a read.

**Rule for this file:** an item is ticked only when it is committed with a test
behind it. Verified-and-not-a-defect gets struck through with a note, because a
wrong entry costs more than a missing one — four entries in `backlog.md` sent
people hunting for bugs that were already fixed.

Status at 22 Sep 2026: **21 done, 4 open, 6 parked.**

The seven parked items are not started without being asked — six of them
pre-launch work that never existed, one a monitoring piece recorded on request.

---

## A. Correctness — wrong answers today

- [ ] **A5. `posts.media` refresh does not scale** — S
  `RefreshPostMetrics` does 200 channels per daily tick, so above 200 active
  channels a channel is reached every `ceil(N/200)` days — longer than the ~35h
  link life. Fine today, silent at scale.
- [ ] **A3. Disconnect a connection** — S — **A2 depends on this**
  There is no disconnect endpoint. None. It is not even listed in backlog §3
  as a missing one. Until it exists, A2's refusal is a **lockout**: a business
  that has lost the original Facebook login cannot release the Page and cannot
  reconnect. Decided 19 Sep to ship the refusal first and this after.

## B. Safety and correctness of the integration

- [x] **B2. System roles are never reconciled** — 22 Sep — `1fc8604`.
  Reconciliation runs at the end of every seed: adds a missing role, adds a
  missing grant, corrects a drifted level. Additive except the level, which is
  corrected because the level IS the hierarchy. On its first real run it
  propagated 34 grants to the two existing tenants.
- [x] **B3. Staff roles are a fiction** — 22 Sep — `64e9db5`, migration
  `1758300000000`. `staff_roles` has no `enterprise_id` — staff authority is
  not scoped to a business, which is what makes it staff authority — and the
  composite FK through `(role_id, role_scope)` makes granting a TENANT role to
  staff unrepresentable. `has_all_enterprise_access` stays the superuser switch,
  so no existing admin's access moved.

## C. Resource and scale

- [ ] **C1. Throttler keys grow without bound** — M
  In-memory store never evicts; per-process limits also multiply by replica
  count. Needs Redis, or a sweep and a cap.
- [ ] **C2. Backfill holds one lease for a serial batch** — M
  The tail of a large batch is guaranteed to overrun its lease.

## D. Structure

- [ ] **D1. `handleCallback` is a god method** — M — ~150 lines over eight concerns.

---

## E. Found during the RBAC work, not fixed

- [ ] **E7. The inbox SSE stream is not filtered by conversation kind** — S
      `GET /conversations/stream` emits a refId whenever anything in the tenant
      changes. The payload is ids only and the detail read now refuses a kind
      the actor may not see (404), so nothing readable leaks — but somebody
      holding only `mentions.view` still learns that a DM thread exists and
      when it changed, and could count activity. Fixing it means carrying the
      conversation kind on the NOTIFY payload so the stream can filter.
- [ ] **E8. A separate `mention_monitoring` feature** — S
      Mentions are deliberately gated on `unified_inbox` rather than a feature
      of their own, because a new feature key breaks every existing tenant the
      moment it ships — nobody holds a feature that did not exist yesterday, so
      mentions would go dark until an admin granted it business by business.
      Splitting it out is a feature insert plus a backfill for everyone holding
      `unified_inbox`. That is a commercial decision, not a side effect.
- [ ] **E9. `GET /employees/roles` does not say what is assignable** — S
      The invite form offers every role; the server then refuses one above the
      inviter's level with a clear message. `GET /roles` carries `assignable`
      and is the endpoint to move that form to.
- [ ] **E10. Removing a permission from a template never reaches tenants** — S
      Reconciliation is additive on purpose: taking a permission away from a
      live tenant removes something people are using right now, and deserves a
      considered migration rather than a side effect of a boot-time seed. So a
      withdrawn permission lingers on older tenants until somebody removes it
      deliberately.

## Parked — recorded, do not start

Work that is understood and deliberately not scheduled. **Do not pick these up
without being asked**, however well they fit whatever else is being done.

### Pre-launch work — on hold 18 Sep 2026

Never started, and not regressions: none of this ever existed. **Do not start
any of it without being asked.** E1 and E2 are not mine to finish alone anyway
— one needs a provider account and credentials, the other needs a decision
about where secrets live.

- [ ] **E1. A real email/SMS provider** — M — every code is still `666666`.
- [ ] **E2. Secret manager** — M — secrets come from the environment, no rotation path.
- [ ] **E3. Metrics** — M — no counters, latencies or retry gauges. *(Listed twice
      in `backlog.md`, in both tables. One piece of work, not two.)*
- [ ] **E4. Committed OpenAPI document** — S — the export script exists and is unused.
- [ ] **E5. Docker image never built** — S — Dockerfile and compose entries never exercised.
- [ ] **E6. Regenerate the migration before the first deploy** — M
      Development uses `pnpm db:sync`, so the migration is deliberately behind.
      This is the gate that makes it authoritative again.

### Other parked work

- [ ] **P1. Back off on Meta's rate-limit headers BEFORE being refused** —
      researched 21 Sep, see platform-limitations §0.4. The research found and
      fixed a live defect (BUC throttle codes were unmapped and dead-lettering
      retryable work). What remains is the proactive half: nothing reads the
      usage percentages on a SUCCESSFUL response, so we still cannot slow down
      before Meta says no. Headers, formulas and pools are now documented.
      Every Graph response carries the budget we have already spent, and we
      currently read none of it — so the first sign of trouble is a `(#4)` or
      `(#17)` error, which is the point at which a business's inbox has already
      stopped updating.
      The headers to read: `X-App-Usage` (call volume, CPU and total time, each
      a percentage of the app's hourly budget),
      `X-Business-Use-Case-Usage` (the same per business, keyed by business id,
      and the one that matters for a multi-tenant product — it also carries
      `estimated_time_to_regain_access` once throttled), and
      `X-Ad-Account-Usage` where it appears.
      What it needs: parse them where responses are already handled
      (`graph-api.client.ts`), record them per channel, expose them as gauges,
      and let the pollers and the backfill back off on the percentage BEFORE
      Meta refuses — the point being to never reach the error, rather than to
      recover from it politely. A throttled tenant should also be visible in
      `/health/detail` rather than inferred from logs.

## Done

- [x] **The correlation id was caller-supplied** — 17 Sep — `1abe6bd`.
      Fixed in `logger.config.ts`, not the middleware the entry named.
      backlog §1.6.
- [x] **`GET /employees` was unpaginated** — 17 Sep — `35056fe`, portal `2b8d75e`.
- [x] **Three copies of `clampLimit`** — 17 Sep — same commit. They had drifted.
- [x] **Neither retention sweep could use an index** — 17 Sep — `0fafbfc`,
      migration `1757600000000`. backlog §1.12.
- [x] **A4. Expired attachment links can now be replaced** — 19 Sep.
      `POST /conversations/:refId/attachments/refresh`, called by the client
      when an image fails — which is the only party that can tell, since these
      links carry no expiry. **Recovers only what Meta still returns** (~20
      most recent messages); older media is permanently gone and is counted as
      `beyondReach` so a client stops asking and offers the permalink.
      platform-limitations §6.2.
- [x] **Mention media and customer avatars expired, never refreshed** — 19 Sep.
      **Verified end to end against the live API**, not just unit-tested — which
      is what caught the first attempt being broken: a 1.5s read budget applied
      to a call that takes 3–5s, so it timed out every time and silently served
      stale links. The mention refresh now runs BEHIND the response (35ms open,
      fresh within seconds); the avatar refresh stays inside it at 756–866ms.
      Avatars were also barely populated — one customer of five — because they
      were only fetched during a backfill. platform-limitations §6.1, §6.2.
- [x] **A2. One Page, one connection, per business** — 19 Sep — migration
      `1758000000000`. Refuse, as decided: `CHANNEL_ALREADY_CONNECTED`. The
      harm was not duplicate processing — the inbound dedup key is scoped by
      enterprise and catches the second copy — it was that events attach to the
      OLDER channel, so reconnecting appeared to work and changed nothing while
      the token stayed dead. Index scoped by enterprise, never global: an
      agency and its client must still both connect one Page. **See A3.**
- [x] **B1. Graph responses were not runtime-validated** — 18 Sep. All 23 call
      sites carry a schema; `request<T>` cannot be called without one. The
      response types are now INFERRED from the schemas rather than declared
      twice. A mismatch fails at the boundary as
      `UPSTREAM_CONTRACT_CHANGED`, permanent, naming field paths and never
      values.
- [x] **D2. Controllers read repositories directly** — 18 Sep. **Five, not the
      three the entry named** — Auth, Enterprises, Employees, Connections and
      Inbox. The inbox one mattered: it held the tenant-scoping check that made
      assignment safe, in the layer least likely to be re-read when assignment
      changes. New `EnterprisesService`; the rest moved to existing services.
      Guarded by `test/unit/controller-layering.spec.ts`.
- [x] **C3. The ledgers had no retention** — 18 Sep — migration
      `1757900000000`. **Wider than the entry said**: it named the metrics
      refresh, but `inbound_events`, `outbound_events` and `sync_jobs` had no
      retention *at all* and grew forever. The metrics refresh was only the
      guaranteed daily floor under that growth. 30-day window, set against
      Meta's redelivery rather than disk — see the note below.
- [x] **C5. `LISTEN` clients had no TCP keepalive** — 18 Sep. **Two** clients,
      not one: the queue listener and the inbox SSE stream. Both now pass
      `keepAlive`, so a reclaimed socket becomes an error both already handle
      by reconnecting.
- [x] **C4. Queue gauges scanned three ledgers** — 18 Sep — migration
      `1757800000000`. One subquery per gauge instead of one pass per table
      with `FILTER`, so each matches a partial index that already existed. The
      one that did not exist — `sync_jobs_dead_letter_idx` — is added.
- [x] **A1. Keyset cursors lost sub-millisecond precision** — 18 Sep —
      migration `1757700000000`. Fixed at the root instead of per query: every
      timestamptz column is millisecond now, so no listing can reintroduce it
      and plain b-tree indexes still work. The `date_trunc` workaround added to
      employees on 17 Sep is reverted. backlog §1.11.

## Checked, not a defect

- ~~A partially-walked sync job sits in `running`~~ — 17 Sep. The entry described
  the design. `LeaseReaperWorker` reclaims it alongside the two ledgers, and
  `claimBatch` always stamps `lease_expires_at`, so no row reaches that status
  without a lease to expire.

---

## Why ledger retention is 30 days and not less (C3)

`inbound_events_dedup_uniq` is the only thing standing between a webhook Meta
sends twice and a duplicate message in a customer's thread — and that guarantee
lives in the row. Sweeping a settled row gives it up for that event.

So the window is a correctness floor, not a disk preference. Meta retries a
failed delivery for hours, and a subscription disabled and re-enabled can
replay further back. Thirty days is comfortably past all of it. Shortening it
trades somebody seeing the same message twice for storage, which is not a trade
worth making — if disk ever becomes the pressure, partition the ledgers rather
than shorten this.

Dead letters are never swept at any age: a terminal failure is a human's
problem and the queue gauge alarms on it, so sweeping one would erase the
evidence and the alarm together.

---
