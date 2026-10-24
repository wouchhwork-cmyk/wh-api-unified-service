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

### 1. Finish the PR review — IN PROGRESS

Ten-plus rounds against `feature/engagement-programs`, end to end: SOP
compliance (`docs/sop.md`), layering, logic, patterns, the lot. Reference
`.claude/skills/pr-review`. Fix what is found, with a test for each fix.

### 2. Kill the ports — AFTER the review

The user asked for "all ports on the mac". Interpret as DEVELOPMENT processes:
the dev API on :3000, the worker (`dist/workers/main.js`), any stray node/vite
listeners started for this work. **Do NOT kill system daemons or anything not
started for development** — report what was killed rather than guessing wide.
Doing this before the review ends is wrong; the review may need to run things.

### 3. Pop the stash, then research autonomous chat agents

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
