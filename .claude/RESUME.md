# Resume state

Written for a FRESH Claude session with no memory of this work. Read this
first, verify against git, then continue from "Next action".

Updated by hand as work progresses. If it disagrees with git, git wins — and
fix this file.

---

## Standing rules that survive any restart

- **Never commit the auto-message / DM work.** It is stashed, deliberately.
  `git stash list` → the entry labelled `auto-message: reward thank-you DM`.
  The user is still trying it out and has said twice not to commit it.
- No `Co-Authored-By:` trailer, no "Generated with Claude Code" on any commit.
- Never push unless asked. The PR task below is an explicit exception.
- Never inject synthetic webhooks into the dev DB. Test with real messages or
  the test suites.
- Before debugging API behaviour, check which process holds :3000 — a restart
  can add an instance rather than replace one.

## Where things are

- API: `/Users/NI013/Documents/Om Docs/depos/wouch/wh-api-unified-service`
- Portal: `/Users/NI013/Documents/Om Docs/depos/wouch/wh-web-web-portal`
- Branch (both): `feature/engagement-programs`
- Dev API + worker run from `dist/`: rebuild with `pnpm build`, then restart
  both. They do NOT hot-reload.

## Gate before any commit

`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:all`
plus `pnpm test:schema` when anything touches the schema.
Last known green: 620 unit / 342 integration / 264 e2e.

---

## Overnight task list (given 2026-10-25, user asleep)

Work them in order. **Nothing merges until the user says so**, explicitly, in
their own words. Opening a PR is allowed; merging is not.

### 1. PR review — DONE (2026-10-25)

Ten rounds run. Five real findings, all fixed with a test, all pushed.
`5b30461` on the API, `bf67119` on the portal. Gate green: 620 unit / 342
integration / 272 e2e / 7 schema.

| round | area | outcome |
|---|---|---|
| 1 | Architecture & layering | clean |
| 2 | Validation & idempotency | **2 × P0** — adjustment endpoint not idempotent; underlying ledger post moved the balance twice on a replay |
| 3 | Security & access control | 1 × P1 — enum interpolated into SQL (safe, but no exceptions to the rule) |
| 4 | Backward compat & migrations | clean — destructive steps are in down(), no blocking NOT NULL |
| 5 | Business logic | clean |
| 6 | Data model & DB | clean — no N+1, 27 reward indexes |
| 7 | Performance | clean — the per-trigger write loop is bounded at 14, in a transaction |
| 8 | Concurrency | **1 × P0** — two concurrent programme edits raced; fixed with a row lock |
| 9 | Error handling & PII | clean |
| 10 | Testing & quality | 1 × P1 — the 409 on a taken name was never tested on either path |

**Still open, recorded in `docs/backlog.md` rather than fixed:**
`debitIfSufficient` carries the same replay defect `post()` had. Fixing it
changes its contract — it must throw on insufficient funds instead of returning
null, because an append-only table cannot withdraw the claimed key. That is a
decision about the conversion flow and needs the user.

**PR still not opened.** `gh` cannot: the active account `oml-nova` has READ
only; the account with write access is `don44112000` and `gh auth switch` was
denied by the permission classifier. The user must switch it or open the PR.
Body is ready. **No merge until the user says so.**

### 2. Kill the ports — DONE (2026-10-25)

Killed the dev API (:3000), its worker, and a stray `node server.js` on
:5173. Deliberately LEFT: postgres (holds the dev data), mongod, the user's
editor and language servers, chrome-devtools-mcp, and a mocha run belonging to
a different repo. "All ports" was read as development servers, not system
daemons — killing a database or their editor while they sleep is not what was
asked for.

### ~~2. Kill the ports — AFTER the review~~

The user asked for "all ports on the mac". Interpret as DEVELOPMENT processes:
the dev API on :3000, the worker (`dist/workers/main.js`), any stray node/vite
listeners started for this work. **Do NOT kill system daemons or anything not
started for development** — report what was killed rather than guessing wide.
Doing this before the review ends is wrong; the review may need to run things.

### 3 & 4. Stash popped, research DONE (2026-10-25)

Stash restored and compiles on the new base. **Still must not be committed.**

Two documents written and committed:
- `docs/research/autonomous-chat-systems.md` — the machinery that holds a
  conversation; what we have, what we lack, and the Instagram constraints that
  shape all of it
- `docs/research/ai-driven-conversation.md` — context, memory tiers, steering,
  tool-calling as the real-time feed, failure modes, prompt-injection risk

Both end with an explicit "what this did NOT establish" section. Every vendor
number is labelled as one. Meta's own docs were NOT read — that is flagged as
required before building anything against the Messaging API.

### ~~3. Pop the stash, then research autonomous chat agents~~

`git stash pop` the entry labelled `auto-message: reward thank-you DM`.
**It still must not be committed.**

Then research how autonomous customer-chat systems are actually built, and
write findings to a markdown file with references.

### 4. Deep research — AI-driven autonomous chat

The harder half, and the user wants it in depth. How such systems are really
implemented: how the AI, our system and the user interact; how the AI is given
context about a user; how a conversation is steered toward an intended
outcome; how data is fed to the model in real time based on what its previous
response indicated it needed and where the conversation is heading.

Deliverable for 3 and 4: markdown with findings, learnings and references.
Depth is explicitly requested over brevity.

---

## Current task

**Ten review rounds against `feature/engagement-programs`, fixing what they
find, then a PR into `main`.** Checklist: `.claude/skills/pr-review`.

### Blocked on the user

`gh` cannot open the PR: the active account `oml-nova` has READ only on
`wouchhwork-cmyk/wh-api-unified-service`. The account with write access is
`don44112000`, and `gh auth switch` was denied by the permission classifier.
**The user must either switch the account or open the PR themselves.** The PR
body is written and saved — see "Artefacts" below.

### Rounds done

| # | Area | Result |
|---|---|---|
| 1 | Architecture & layering | clean — no SQL outside repositories, no repo→service imports, controllers branch-free |
| 2 | Validation & idempotency | **P0 found and fixed** — see below |

### Round 2 finding (fixed, not yet committed)

`POST /rewards/adjustments` — the one endpoint where a person moves real value
— was not idempotent. `reward_ledger_entries` has a unique index on
`(enterprise_id, idempotency_key)`, but the service generated a fresh
`randomUUID()` per call, so the index could never fire and a retried request
credited the customer again.

Fixed by taking a REQUIRED client-supplied `idempotencyKey` on the request,
with the portal holding one key per adjustment and clearing it only on success.
Not yet committed. **No test yet** — write one before committing.

### Rounds remaining

3. Security & access control — auth, tenant scoping, injection, error leakage
4. Backward compatibility & contract safety
5. Business logic — state machines, invariants, edge cases
6. Data model & DB — indexes, N+1, transactions, migrations
7. Performance & scalability
8. Concurrency & distributed behaviour
9. Error handling & observability, including PII in logs
10. Testing, code quality, hardcoding, release readiness

## Next action

Write the missing test for the Round 2 idempotency fix, then continue at
Round 3.

## Artefacts

- PR body: `<scratchpad>/pr-body.md` (scratchpad path is session-specific; if
  gone, rewrite from the commit messages — they carry the reasoning)
- Backlog additions this session: `docs/backlog.md` — attachment media never
  fetched, six of seven triggers never fired, can-we-send-media unverified
