# Deploying this release

Three steps, in this order, and the order is not a preference. Each section says
what breaks if it is done differently, because "migrations first" is a rule
everybody knows and "seed second" is not.

```
1.  pnpm migrate          schema
2.  pnpm db:seed          catalogue + reconciliation
3.  deploy the code       API and workers
```

---

## 1. Migrations

`1758100000000-ProviderApiUsage`, `1758200000000-RoleLevels`, `1758300000000-StaffRoles`.

All three are expand-only and safe to run while the **previous** release is
still serving. That is not automatic — `RoleLevels` adds a `NOT NULL` column to
`roles`, and the previous release's `instantiateSystemRoles`, which is the
signup path, inserts a role without naming it. The column therefore carries a
`DEFAULT` of the bottom level, attached **after** the backfill so the backfill
still sees NULLs. `test/integration/migration-rehearsal.spec.ts` runs exactly
this sequence against a database with a business already in it — via
`pnpm test:schema`, which is the pre-deploy gate and is the only thing that
runs it.

**Locks.** `RoleLevels` holds `ACCESS EXCLUSIVE` on `roles` for the length of one
transaction — six updates and two alters over a tiny table, but signups block for
the duration. `StaffRoles` takes a brief lock on `roles` too, via the unique
index and foreign key that `applyLateTableObjects` creates. Deploy at a quiet
moment; neither needs a window.

## 2. The seed — **before the code, not after**

`pnpm db:seed` inserts this release's new permissions and reconciles every
existing business against the role templates.

**If the code ships first, two things break for every existing tenant:**

- **Mentions disappear from the inbox.** `mentions.view` is a new code. Until
  the seed runs, no role holds it — and the listing is filtered by the kinds an
  actor may see, so mention threads stop being returned.
- **Assigning or closing a comment thread starts returning 403**, because
  `comments.assign` and `comments.manage` are new in the same way.

Seed-before-code is safe in the other direction: the old code ignores permission
rows and grants it does not know about.

**Run it again once the rollout has finished.** A business that signs up in the
window between step 1 and step 3 is served by the previous release, whose
`instantiateSystemRoles` does not write a level — so all four of its system
roles arrive at level 0, including `owner`. That owner cannot invite, re-role or
suspend anybody, because every authority rule compares levels and theirs equals
everyone else's. Reconciliation step 3 corrects a drifted level from the
template, so a second seed repairs it. Nothing repairs it automatically.

## 3. The code

API and workers together. Both make Graph calls and both need the rate-limit
collector; the API alone would report a fraction of the platform's traffic as
though it were all of it.

---

## One customer-visible removal, decide before deploying

Comment threads move from `conversations.*` (gated on `unified_inbox`) to
`comments.*` (gated on `comment_management`). That closes a real leak — a
business whose comment feature was **revoked** kept full comment access,
including deleting a customer's comment from a public post — and it is still a
removal somebody will notice.

Check for it first:

```sql
SELECT e.name
  FROM enterprises e
  JOIN enterprise_features inbox ON inbox.enterprise_id = e.id AND inbox.status = 'active'
  JOIN features fi ON fi.id = inbox.feature_id AND fi.key = 'unified_inbox'
  LEFT JOIN enterprise_features cm ON cm.enterprise_id = e.id
       AND cm.feature_id = (SELECT id FROM features WHERE key = 'comment_management')
 WHERE cm.status IS DISTINCT FROM 'active';
```

Anything this returns loses comment access on deploy. Either grant them
`comment_management` beforehand or tell them. As of 22 Sep 2026 one tenant was
in exactly that state.

---

## Rolling back

**Code first, then the migration.** `RoleLevels.down()` drops `roles.level`,
which the new code selects on every role read — rolling the migration back under
live new code breaks roles outright, and there is no fallback for a missing
level.

The seed has no rollback and needs none: it only adds rows, and a permission
nothing references is inert.

---

## After deploying

- `GET /v1/platform/rate-limits` should answer, and the app pool should show
  movement as businesses reconnect. It is fed by ordinary traffic, so an idle
  deployment showing nothing is correct rather than broken.
- Check `docs/todo.md` §E for what this release deliberately did not fix.
