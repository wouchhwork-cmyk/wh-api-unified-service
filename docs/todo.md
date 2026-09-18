# Todo

The working checklist. `docs/backlog.md` holds the reasoning and the evidence;
this holds the order and the state, so "what is left" is one glance rather than
a read.

**Rule for this file:** an item is ticked only when it is committed with a test
behind it. Verified-and-not-a-defect gets struck through with a note, because a
wrong entry costs more than a missing one — four entries in `backlog.md` sent
people hunting for bugs that were already fixed.

Status at 18 Sep 2026: **4 done, 19 open** (one of the 19 was found, not
inherited — see C1).

---

## A. Correctness — wrong answers today

- [ ] **A1. Keyset cursors lose sub-millisecond precision** — S — *in progress*
  Postgres stores microseconds; a cursor round-trips through a JS `Date`, which
  does not. Ascending repeats the cursor row forever; descending **silently
  skips** rows sharing that millisecond. Fixed in `employees` only (17 Sep).
  Left: `platform-admin`, `conversation` (inbox), `customer`/`post`
  (catalogue). backlog §1.11.
- [ ] **A2. `provider_connections` uniqueness** — S — **needs your decision**
  One tenant can hold two channel rows for the same Page, because
  `channels_platform_uniq` includes `provider_connection_id`. The index is the
  easy part; what happens when a business reconnects through a *different*
  Facebook login is a product question. See the note at the bottom.

## B. Safety and correctness of the integration

- [ ] **B1. Graph responses are not runtime-validated** — M
  Every response is cast to `T` with no check. Most remaining Meta findings
  collapse into one zod schema at that boundary.
- [ ] **B2. System roles are never reconciled** — M
  Copied once at signup, so a permission added in a later release never reaches
  an existing tenant.
- [ ] **B3. Staff roles are a fiction** — M
  `support` and `ops` seed as `RoleScope.Staff` templates that can never be
  granted. The exposure is gone (the permission query is fail-closed); what
  remains is that the two templates mean nothing.

## C. Resource and scale

- [ ] **C1. Throttler keys grow without bound** — M
  In-memory store never evicts; per-process limits also multiply by replica
  count. Needs Redis, or a sweep and a cap.
- [ ] **C2. Backfill holds one lease for a serial batch** — M
  The tail of a large batch is guaranteed to overrun its lease.
- [ ] **C3. The daily metrics refresh has no retention** — S
  One `inbound_events` row per post per day, kept forever.
- [ ] **C4. Queue gauges scan three ledgers** — S
  Three unfiltered aggregate scans per sample and per `/health/detail`.
- [ ] **C5. `LISTEN` clients have no TCP keepalive** — S
  A socket reaped without FIN leaves a zombie listener. Latency only — every
  worker still polls its own timer — and deployment-dependent.

## D. Structure

- [ ] **D1. `handleCallback` is a god method** — M — ~150 lines over eight concerns.
- [ ] **D2. Some controllers read repositories directly** — S — Auth, Enterprises, Employees.

## E. Not built yet — pre-launch, not regressions

- [ ] **E1. A real email/SMS provider** — M — every code is still `666666`.
- [ ] **E2. Secret manager** — M — secrets come from the environment, no rotation path.
- [ ] **E3. Metrics** — M — no counters, latencies or retry gauges. *(Listed twice
      in `backlog.md`, in both tables. One piece of work, not two.)*
- [ ] **E4. Committed OpenAPI document** — S — the export script exists and is unused.
- [ ] **E5. Docker image never built** — S — Dockerfile and compose entries never exercised.
- [ ] **E6. Regenerate the migration before the first deploy** — M
      Development uses `pnpm db:sync`, so the migration is deliberately behind.
      This is the gate that makes it authoritative again.

---

## Done

- [x] **The correlation id was caller-supplied** — 17 Sep — `1abe6bd`.
      Fixed in `logger.config.ts`, not the middleware the entry named.
      backlog §1.6.
- [x] **`GET /employees` was unpaginated** — 17 Sep — `35056fe`, portal `2b8d75e`.
- [x] **Three copies of `clampLimit`** — 17 Sep — same commit. They had drifted.
- [x] **Neither retention sweep could use an index** — 17 Sep — `0fafbfc`,
      migration `1757600000000`. backlog §1.12.

## Checked, not a defect

- ~~A partially-walked sync job sits in `running`~~ — 17 Sep. The entry described
  the design. `LeaseReaperWorker` reclaims it alongside the two ledgers, and
  `claimBatch` always stamps `lease_expires_at`, so no row reaches that status
  without a lease to expire.

---

## The one decision I need from you (A2)

Today a business that reconnects through a different Facebook login gets a
second `provider_connections` row, and therefore a second `channels` row for
the same Page — duplicate webhooks, duplicate conversations, the Page listed
twice.

A unique index on `(enterprise_id, platform, platform_channel_id)` stops it.
What it cannot decide is what should happen at that moment:

1. **Move the Page** onto the new connection, keeping its conversations and
   history. Right when someone re-authorises with a personal account after
   using a shared one — the common case, I think.
2. **Refuse the connection** and tell them the Page is already connected. Safer,
   and irritating if they no longer control the old login.

I would build (1) unless you say otherwise, since (2) can strand a business
with no way back in. Everything else on this list I can decide myself.
