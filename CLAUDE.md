# Development rules for this service

These apply to every change in this repository, in addition to the global
coding guidelines. They exist because each one was already violated once, in
code that looked correct and carried a comment saying it was.

---

## 1. Every state change is recorded, and the record names the actor

**The rule.** Any code path that creates, changes, removes or withdraws
something writes an `audit_logs` row through `AuditService.record`, in the same
transaction as the change it describes.

That is not limited to endpoints a person calls. **An action the platform takes
by itself is still an action**, and is recorded with `actor_kind = 'system'` —
a reward granted to a customer, an award reversed because the content behind it
was deleted. "Nobody decided this, a rule did" is the answer the customer is
owed when they ask why their balance moved, and it can only be given if the row
exists.

**What counts, concretely:**

| Recorded | Not recorded |
| --- | --- |
| A row written, changed, archived or revoked | A read, a list, a search |
| Permissions or roles granted **or taken away** | A no-op — the asked-for state already held |
| Sign-in, failed sign-in, sign-out, impersonation | A health check |
| Connecting or disconnecting a provider | A projection of an inbound webhook into the inbox |
| Moderating or replying to a customer's content | A retry of something already recorded |
| Value granted, reversed or manually adjusted | A refusal to act that changed nothing |

**The actor is never passed in.** `AuditService` reads it from
`RequestContext`, so a call site cannot record an action under the wrong name.
Where no session exists — an OAuth callback, a signup, a worker tick — the row
correctly says `system`, and whatever attribution *is* available goes in
`metadata`. Do not invent a route-specific way to set the actor columns; that
is the hole this design closes.

**Write it inside the transaction.** `AuditService` joins the ambient one. A
record written outside can claim something that then rolled back.

### The action must say what actually happened

Reusing a near-enough action is worse than recording nothing, because a wrong
row is read as fact. This has gone wrong twice:

- A role **replace** recorded `role_granted` unconditionally, with metadata
  listing only the new set. Stripping somebody of every role wrote
  `role_granted` with `roles: []`.
- `unhidden` does not exist as `hidden`, and did not become `updated`.

If no existing `AuditAction` is honest, **add one**. The enum is cheap; a
misleading audit row is not.

### Never put content or credentials in a record

`changes` and `metadata` carry field names, ids, statuses and counts. They do
not carry a message body, a customer's words, an email address, a phone number,
a token, or a `forward_config`. A failed sign-in records that a credential was
tried, never which one — an unauthenticated caller must not be able to write a
real person's address into the trail.

### Declaring it is not doing it

9 of 19 `AuditAction` values and 5 of 15 `AuditEntityType` values were declared
and never written by anything. A vocabulary is not coverage. If you add an enum
member, the change that writes it ships in the same commit.

---

## 2. Configuration that can be edited keeps a version history

**The rule.** When an entity's configuration decides money, access or
behaviour, every change appends an `entity_versions` row via
`EntityVersionService.record` — alongside the audit row, not instead of it.

The two answer different questions and both are needed:

- `audit_logs` — **who** changed it, when, from where.
- `entity_versions` — **what it then was**, in full.

`changes` holds only the fields a call site chose to name, so reconstructing a
past state from the audit log means replaying every diff since creation and
trusting that none omitted anything. An award made last March was decided by
the program **as it stood last March**, and that has to be answerable by reading
one row.

**The snapshot is stated, never serialised from the row.** A reward program
carries `forwardConfig`, which holds a credential reference, and the history is
append-only — a secret written there can never be taken back out. List the
fields by hand, in one `snapshotOf` helper per entity, so adding a column is a
decision rather than an accident.

**Do not compute the diff at the call site.** `EntityVersionService` derives it
from the two snapshots. Every call site that describes its own change is a call
site that can describe it wrongly.

Applies today to reward programs. `reward_rules` solve the same problem their
own way — a `version` column and `supersedes_rule_id`, with the deciding version
stored on each award — which is equally acceptable: what is not acceptable is
an editable entity with no history at all.

---

## 3. A record of what happened is append-only in the database

**The rule.** `audit_logs`, `entity_versions` and `reward_ledger_entries` are
enforced append-only by a `BEFORE UPDATE OR DELETE` trigger that raises. Any
new table of this kind gets one, created in **both** paths — the migration and
`schema-objects.ts` — because a database can be built either way.

**A trigger, not a REVOKE.** The REVOKE on `audit_logs` is guarded on the
application role differing from the migration role. On every developer machine,
and anywhere `DB_APP_ROLE` is unset, they are the same user and the guard does
nothing — so for a long time the application role held `UPDATE`, `DELETE` and
`TRUNCATE`, while the entity and the repository both stated in comments that it
did not. Measured, not assumed: both statements succeeded against a real row.

**The honest limits, which are stated rather than discovered:** `TRUNCATE` is
not blocked (a row trigger cannot see it, and the test harness needs it), and
a role with DDL rights can drop the trigger. It stops the accidental UPDATE and
the well-meaning repair script, which is the realistic threat.

**`updated_at = created_at` is a tamper tripwire** on these tables, and it only
means anything because of the trigger. On a table the application can edit, it
says nothing at all.

---

## 4. Assert the guarantee, do not describe it

Every rule above was documented as true before it was true. A comment asserting
a property is not evidence of it.

- A database-level guarantee gets an integration test that **attempts the
  forbidden thing** and expects a rejection — see
  `test/integration/audit-trail-guarantees.spec.ts`.
- A control with a threshold gets a test proving it can actually **fail**. The
  reward program budget was removed because its guard could never bind: the
  claim short-circuited on a zero cost, so a program with a twelve-paise budget
  granted awards with nothing counted against it. **A control that cannot fail
  is worse than no control**, because the screen promises a ceiling nobody
  enforces.
- Verify behaviour against the **shipped** code path. A test that
  re-implements the logic it is checking proves only that the copy agrees with
  itself.

---

## 5. Read it back from the database before saying it works

Configuration is not evidence of state. Before reporting that a control, a
grant, a trigger or a migration is in force, query the database for it. Both
defects above were found that way and neither was visible in the code.
