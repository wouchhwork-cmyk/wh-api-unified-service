# Rebuilding role-based access control

Written 22 Sep 2026, from a full read of the existing implementation. The plan
comes first because most of the risk here is design risk: an access-control
system that is merely *present* is not the same as one that holds, and the
failure mode is silent.

---

## 1. What is already right, and must survive

Worth stating, because a rebuild that loses these would be a regression however
much it adds.

- **One engine, two gates.** A permission is held only if the role grants it
  *and* the enterprise's feature for it is active. Composed in SQL, in
  `permission.repository.ts`.
- **Resolved per request, fail-closed.** Guards are global and opened up with
  `@Public`, so forgetting a decorator denies rather than permits. Revoking a
  feature takes effect on the next request with the *same* token.
- **Cross-tenant grants are structurally impossible.** `employee_roles` carries
  a composite foreign key `(role_id, enterprise_id)`, so pairing one business's
  employee with another's role cannot be represented. This is enforced by the
  database, not by a check that can be forgotten.
- **No precedence puzzle.** Permissions are a flat set with no deny rules, so
  there is no ordering to get wrong.
- **Identity comes only from the token.** `ActorContext` is built by the guard
  chain and never from a request body.

None of this changes.

---

## 2. What is wrong

### 2.1 The thing the product was asked for does not exist

| Asked for | Today |
| --- | --- |
| A business creates its own roles | **No role CRUD anywhere.** `roles.manage` exists as a code and is enforced on nothing. |
| Permissions chosen from a list grouped by area | No such list is exposed. `GET /employees/roles` returns `{refId, name}` and **no permission information at all** — a client cannot show what a role grants. |
| Role levels, "a manager cannot create a manager" | **No level, rank, seniority or hierarchy column exists.** |
| Grant only a subset of what you hold | No such check. |
| An agent sees agents, not managers | No visibility filtering. Everyone with `employees.view` sees everyone. |
| Creating employees is itself a permission | This one exists — `employees.invite`. |

The *entire* "who may hand out what" logic today is one string comparison:

```ts
if (role.name === 'owner') { /* only an owner may grant owner */ }
```

That is `employees.service.ts:149-154`. It is correct as far as it goes, and it
is the only thing standing between a manager and full control of the business.

### 2.2 The margin is thin, and rests on absent endpoints

An employee cannot escalate today — but only because there is no route to
change a role, no route to create a role, and no route to edit one. Every one
of those is being added by this work. The moment they exist:

- a manager with `roles.manage` could edit the `agent` role to include
  `enterprise.manage`, then invite into it, and the owner check above is
  bypassed entirely;
- nothing checks `roles.scope` at assignment, so a staff-scoped role could be
  granted if it were ever reachable;
- nothing stops a manager suspending the owner — `setStatus` blocks only
  *self*-suspension.

**So the level and subset rules are not a feature on top of role editing. They
are the precondition for it.** They ship together or not at all.

### 2.3 The catalogue has fallen behind the product

24 permissions over 9 resources. Measured against what the product now does:

- **Mentions have no permissions at all.** They are a first-class surface with
  their own screen, their own media-refresh path and their own webhook
  handling, and they are governed by `conversations.*` because they happen to
  be stored as conversations. A business cannot let somebody handle mentions
  without also giving them the DM inbox.
- **`comments.*` is enforced nowhere** — four codes, zero call sites.
- So are `customers.manage`, `roles.manage`, `features.view`,
  `features.request`, `features.decide`, `enterprise.manage`, `channels.manage`.
- There is no code for reading the **audit trail**, for triggering a **resync**,
  or for the **rate-limit console** just added.

Two different problems live in that list and need different fixes: codes with
no endpoint (wire them up or drop them), and capabilities with no code (add
them).

### 2.4 Platform-side access control is a single boolean

`staff_members.has_all_enterprise_access`. Every platform admin has identical
authority over every business: read everything, activate, suspend, grant and
revoke features.

`support` and `ops` exist as seeded roles and are **structurally ungrantable** —
`instantiateSystemRoles` copies only enterprise-scoped templates, and
`employee_roles.enterprise_id` is `NOT NULL` behind a composite FK, so a role
with `enterprise_id IS NULL` can never be granted to anyone. They are inert
rows. (This is backlog B3, confirmed exactly.)

### 2.5 System roles are never reconciled

The catalogue seed is `ON CONFLICT DO NOTHING`, and `instantiateSystemRoles`
runs once, at signup. A permission added to the `agent` template in a later
release reaches no existing tenant, ever. (Backlog B2.)

---

## 3. The design

### 3.1 Levels

Add `roles.level SMALLINT NOT NULL`, **0–100, higher means more authority**.

```
owner    100     manager   70     agent    40     viewer   10
```

Higher-is-more is chosen over a dense 1,2,3 for two reasons. It reads the right
way round — "you may only create roles below your level" — and the gaps let a
business insert `Senior agent` at 55 without renumbering anything.

**An employee's level is the MAX of their active roles' levels**, because an
employee may hold several.

Three rules, and the difference between them is the point:

| Action | Rule |
| --- | --- |
| **See** an employee | `target.level <= actor.level` — an agent sees agents |
| **Create or assign** a role | `role.level < actor.level` — strictly below, so a manager cannot mint another manager |
| **Modify** an employee (suspend, change roles) | `target.level < actor.level` — strictly below, so a manager cannot suspend the owner or another manager |

Plus the two that already exist and stay: nobody acts on themselves, and only an
owner may grant owner.

### 3.2 The subset rule

A grantor may only put into a role permissions they themselves hold.

Checked against the actor's **granted** codes — what their roles give them —
**not** their feature-gated effective set. If the business's inbox subscription
lapses, a manager should not lose the ability to *edit a role definition* that
mentions inbox permissions; the feature gate still applies independently every
time anybody actually uses one. Recording the reasoning because the other choice
looks equally defensible and would produce baffling behaviour.

### 3.3 What a tenant may not touch

- **System roles are immutable per tenant.** `is_system = true` roles can be
  granted but not edited or deleted. A business that wants a different manager
  makes its own role.
- **Level 100 is reserved.** No API path creates a role at the owner's level.
- **The last owner is protected.** Suspending or de-owning the final active
  owner is refused — otherwise a business can lock itself out permanently, and
  there is no disconnect/recovery path (see todo A3 for the same shape of bug).

### 3.4 Catalogue

Split `mentions.*` out of `conversations.*`, add the missing codes, and **wire
up the ones that already exist and guard nothing**. Every new code either gets
an enforcement site in this work or is explicitly listed as declared-ahead, so
the "modelled and unreachable" list does not grow silently.

### 3.5 Platform side

Make `RoleScope.Staff` real: a `staff_roles` grant table (staff have no
enterprise, which is exactly why `employee_roles` cannot carry them), and
`PlatformAdminGuard` keeps working as the outer gate while individual platform
routes gain `@RequirePermission`. `has_all_enterprise_access` stays as the
"may reach into a tenant at all" switch; it stops being the whole authorisation
model.

### 3.6 Reconciliation

A path that re-applies template changes to existing tenants, so B2 stops being
true. Additive only — it must never remove a permission a business has
deliberately changed.

---

## 4. Order of work

Levels and the subset rule land **before** role editing is reachable, because
role editing without them is a privilege-escalation route.

1. `roles.level` + migration + level rules on the existing grant path
2. Employee visibility and modification rules
3. Permission catalogue: split mentions, add missing, wire up unenforced
4. Role CRUD (create, edit, archive) with the subset and level rules
5. Assigning and changing an employee's roles after creation
6. Platform staff roles
7. Template reconciliation (B2)
8. Feature catalogue review

Each step ends green and committed, so an interruption loses at most one step.

---

## 5. Review rounds

No reviewer is available, so this is done deliberately rather than by habit.

- **Round 1 — escalation.** For every new endpoint: can the actor end up with
  more than they started with? Try manager→owner, role-edit→self-grant,
  multi-role level maximisation, and assigning a role from another scope.
- **Round 2 — isolation and compatibility.** Tenant scoping on every new query;
  every existing token and seeded role still resolves; no endpoint changes shape.
- **Round 3 — tests and gate.** Negative tests first; full suite, lint, schema
  parity.
