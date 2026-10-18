# Reward Programs — Design

Enterprises configure what customer social activity earns a reward, how much,
how often, and what form the reward takes. Activity arrives through the
integration we already have; value is recorded in a ledger the enterprise owns.

Companion to [`schema.md`](./schema.md), which decides the data, and
[`engagement-programs-market-study.md`](./engagement-programs-market-study.md),
which is the research this design draws on. Where a choice here matches
something the market converged on, the study section is cited — not as an
appeal to authority, but so the reasoning can be checked rather than taken.

**Decisions already taken**, which the rest of this assumes:

| Decision | Choice |
| -------- | ------ |
| Variable awards | **Formula on the event**, not manual review |
| Money model | **Enterprise liability, redeemable only with that enterprise** — closed loop |
| V1 scope | **Full config surface.** Forwarding behind a stub that reports success; items architected and stored, redemption flow deferred |

---

## 1. How this fits what already exists

The useful finding is how little is new. Three of the five parts of a standard
engagement platform are already in this schema.

| What a reward program needs | What we already have |
| --------------------------- | -------------------- |
| Who gets rewarded | **`customers`** (§16) — one row per human per enterprise |
| What they did | **`messages`** (§21) for DMs, comments and replies; **`posts`** (§19) for mentions and tags |
| Exactly-once on arrival | **`inbound_events`** (§23) — transport dedup, already solved |
| Where they engage | **`customer_engagements`** (§18) |
| Getting value out | **`outbound_events`** (§24) and the `FOR UPDATE SKIP LOCKED` polling pattern |

**The reward member *is* a `customers` row.** No new identity concept, no
mapping table, no resolution step.

That is worth dwelling on, because it removes the hardest problem in this
domain. Published engagement platforms spend most of their identity complexity
on a canonical party record stitched together from email, phone and device —
and the market study records the failure mode when the stitching is shared
across tenants (study §11.1: campaigns isolated per tenant while the customer
profile silently spans them).

We are structurally immune. Meta issues **page-scoped and app-scoped user ids**,
so the same human already has a different IGSID per business
([`schema.md` §16–18](./schema.md)), and `customers` is `enterprise_id NOT NULL`
with no row two enterprises share. Cross-tenant reward leakage is not a test we
have to keep passing; it is a shape that cannot be expressed.

**What is genuinely new** is four things: the program and rule configuration,
the grant-cap mechanism, the value ledger, and the forwarding seam.

### 1.1 Naming

`customer_engagements` already means *"which channels a customer engages on, and
how much."* Adding `engagement_programs`, `engagement_rules` and
`engagement_ledger` would put two unrelated concepts under one word in one
schema — the exact ambiguity `schema.md` cites as the reason `users` was renamed
to `identities`.

**The product feature stays "Engagement Programs". The tables are `reward_*`.**

---

## 2. The pipeline

```
 inbound_events        domain row         trigger          rule           effects         ledger
  (transport)     →   messages/posts  →  normalised   →  match +     →  typed      →  entries +
   dedup              (the fact)          event          evaluate       effects       wallet
```

Two boundaries matter.

**Rules are authored against a normalised event catalogue, never against Meta
payload shapes.** A rule says `STORY_MENTION`, not `"entry[0].changes[0].value"`.
This is the one thing every platform in the study does (§9.1): a registered,
versioned event catalogue is what makes a rule authorable in a UI by someone who
has never seen a webhook. It also means a Meta payload change breaks one mapper
rather than every rule an enterprise has written.

**The rule engine emits typed effects; a separate applier executes them.**

```ts
type RewardEffect =
  | { kind: 'GRANT_POINTS';       points: number;  walletKind: 'POINTS' }
  | { kind: 'GRANT_CURRENCY';     amountMinor: number; currencyCode: string }
  | { kind: 'ISSUE_ENTITLEMENT';  itemRefId: string; expiresAt: Date | null }
  | { kind: 'CONVERT';            fromWallet: ...; toWallet: ...; times: number }
  | { kind: 'FORWARD';            destinationId: number; ledgerEntryId: number }
  | { kind: 'SKIP';               reasonCode: 'CAP' | 'BUDGET' | 'SIGNAL_MISSING' };
```

Every effect carries the `rule_id` and `rule_version` that produced it, so the
ledger can always answer *"which rule caused this?"* — the single most common
support question and the hardest to answer retroactively (study §2).

This is also the answer to building items later. **Adding full item support is
filling in the `ISSUE_ENTITLEMENT` applier and the catalogue behind
`item_ref_id`. Nothing else moves** — not the trigger layer, not the rule model,
not the cap mechanism, not the ledger. That is the whole reason for choosing
effects over letting the rule mutate a wallet directly (study §8).

---

## 3. Triggers — and what Meta actually gives us

### 3.1 The catalogue

| Trigger | Source | Notes |
| ------- | ------ | ----- |
| `STORY_MENTION` | story mention webhook | They mentioned us in a story |
| `COMMENT_ON_OWN_POST` | `messages` on a `posts` row we own | |
| `COMMENT_ON_MENTIONED_POST` | mentioned-media comment flow | Comment on someone else's post that tags us |
| `POST_TAGGING_US` | `mention` webhook | They posted and tagged our account |
| `POST_CAPTION_MENTION` | `mention` webhook | Our handle in their caption |
| `DM_INBOUND` | `messages`, inbound | |

Plus `trigger_filters jsonb` — restrict to specific channels, require a keyword,
require a minimum content age, first-time-only.

### 3.2 Two capability constraints, both real

**`POST_CAPTION_MENTION` may never fire.** Caption mentions depend on mention
monitoring, which is [`todo.md`](./todo.md) **E8** — parked as a commercial
decision, not a technical one. The rule type should exist and simply award
nothing until that is resolved, rather than being absent from the UI and
appearing later as a schema change.

**Private accounts are untested, and this feature is where it hurts.**
[`todo.md`](./todo.md) **A6**: every flow we have verified ran against public
accounts. If a private account posts a story mentioning an enterprise and Meta
sends us nothing, the reward silently never fires — and the customer complains
to the enterprise, who complains to us, about a reward we were never told to
give. **A6 is a prerequisite for trusting this feature, not adjacent work.**

### 3.3 The signal problem — this changes the formula design

`UP_TO` awards need a signal to scale against. Here is what we can actually
read, checked against `graph-api.client.ts` rather than assumed:

**Available:** `posts.like_count`, `posts.comment_count`, `posts.share_count`,
`posts.view_count`, and `like_count` on an individual comment.

**Not available:** insights, `business_discovery` and hashtag search all refuse
with Graph error `#10` — they need permissions this app has not been granted,
and asking for them fails the whole request. So there is **no reach, no
impressions, no views on someone else's content, and no follower count for the
person interacting with us.**

Mapped onto the triggers:

| Trigger | Usable signals | Formula viable? |
| ------- | -------------- | --------------- |
| `COMMENT_ON_OWN_POST` | comment `like_count`, parent post counts, text length | **Yes** |
| `COMMENT_ON_MENTIONED_POST` | comment `like_count`, mentioned media counts | **Yes** |
| `POST_TAGGING_US` | media `like_count`, `comments_count` | **Yes** |
| `POST_CAPTION_MENTION` | media `like_count`, `comments_count` | Yes, if E8 is resolved |
| `STORY_MENTION` | **none** — it is someone else's story and we cannot read its metrics | **No** |
| `DM_INBOUND` | message length only | **Not meaningfully** |

**The headline example in the request — "someone posts an Instagram story about
me, give them up to 20 points" — is the one case where the formula cannot
work.** We have no number to scale against. The rule must degrade to a fixed
award, and the UI should not offer a formula for `STORY_MENTION` at all rather
than offering one that silently always returns the floor.

This belongs in [`platform-limitations.md`](./platform-limitations.md) once A6
confirms the surrounding behaviour.

### 3.4 When the formula is evaluated

Engagement counts are near zero at the moment a comment or post arrives; likes
accrue over hours. Evaluating at event time would award the floor to almost
everyone and make the formula decorative.

**So the formula is evaluated at grant time — the end of the hold period — not
at event time.** The hold then serves two purposes at once: it is the reversal
window for deleted content, and it is the settling time for the metric. A rule
with `hold_hours = 0` evaluates immediately and accepts a low number.

The values used are snapshotted onto the award (§6.4), because the metric moves
and an award that cannot be explained six months later is an award the
enterprise cannot defend to its customer.

### 3.5 The formula itself — a rate table, not an expression language

```
amount = clamp(base + rate × signal_value, floor, cap)
```

Four numbers and a signal name. No parser, no evaluator, no sandbox.

This is deliberate, and it is what the market actually ships. Eagle Eye
configures earn and burn as declarative rate structures with **zero expression
evaluation** and covers the large majority of retail programs that way
(study §2b). Talon.One, which does ship an expression language, states its
safety property as *"no recursion, no infinite loops"* — and no vendor in the
entire study publishes its rule DSL in an API reference, because rule authoring
is a UI concern (study §18).

A rate table is auditable, diffable, renderable in a form, and cannot hang a
request. If a genuine need for conditional logic appears later, it arrives as a
second rule with a filter — not as an interpreter on the hot path.

**When the signal is missing** — a private account, deleted content, a Graph
error — the rule declares what happens: `on_signal_missing` ∈
`{ USE_FLOOR, USE_BASE, SKIP }`, defaulting to `USE_FLOOR`. Silence is not an
option; an award that quietly becomes zero is a support ticket.

---

## 4. Uniqueness and concurrency — the core of the design

Three races exist here, and each is solved by a constraint rather than by a
check in a service. The market study found this same defect class in every
domain it examined, with a published CVE attached (study §4).

### 4.1 One source event never awards twice

```sql
CREATE UNIQUE INDEX reward_awards_source_uniq
  ON reward_awards (enterprise_id, rule_id, customer_id, source_ref_type, source_ref_id)
  WHERE is_deleted = false;
```

A redelivered webhook, a replayed backfill and a retried job all conflict on
this index and return the existing award. **Idempotency comes from the shape of
the data, not from remembering to check.**

Note this sits *below* `inbound_events` dedup rather than replacing it. That
ledger protects the transport; this protects the grant. A single comment can
reach the rule engine through a webhook *and* a sync backfill, which are
different transport events describing the same fact.

### 4.2 Frequency caps — a counter, never a count

"Once per lifetime / day / week / year" is the classic check-then-write race:
two stories posted a second apart both read *"0 awards today"*, both pass, both
grant. This is **CVE-2026-31824** (Sylius, CVSS 8.2) in a different costume —
and there, the ORM made it worse by flushing an absolute value rather than an
increment, so concurrent writers overwrote each other.

The fix is one atomic statement:

```sql
INSERT INTO reward_grant_counters
       (enterprise_id, program_id, rule_id, customer_id, period_key, used, cap)
VALUES ($1, $2, $3, $4, $5, 1, $6)
ON CONFLICT (enterprise_id, rule_id, customer_id, period_key)
DO UPDATE SET used = reward_grant_counters.used + 1
        WHERE reward_grant_counters.used < reward_grant_counters.cap
RETURNING used;
```

**Zero rows returned means the cap is exhausted.** There is no window between
the check and the write because there is no separate check. One statement
handles "once ever" and "three per week" identically.

`period_key` is a computed string, resolved in the **enterprise's timezone**:

| `cap_scope` | `period_key` |
| ----------- | ------------ |
| `LIFETIME` | `'LIFETIME'` |
| `DAY` | `'2026-10-19'` |
| `WEEK` | `'2026-W42'` |
| `MONTH` | `'2026-10'` |
| `YEAR` | `'2026'` |
| `NONE` | no counter row written |

The timezone matters: "once a day" means the enterprise's day. A Mumbai café
running a daily reward does not want it resetting at 05:30 local.

Reversal decrements with `GREATEST(used - 1, 0)` — the same floor the Sylius
remediation uses, so a double reversal cannot drive the counter negative and
hand out a free slot.

> **Rejected: `SELECT ... FOR UPDATE` then count.** It locks only rows that
> already match and does not stop a concurrent insert, so the race survives.
> The market study found this same flaw in the published Sylius patch and in a
> vendor's reference anti-fraud tutorial (study §4.2). A per-customer cap wants
> a counter or a constraint, never a locked count.

### 4.3 Program budget

Same mechanism, one level up:

```sql
UPDATE reward_programs
   SET spent_minor = spent_minor + :cost
 WHERE id = :id AND enterprise_id = :ent
   AND (budget_minor IS NULL OR spent_minor + :cost <= budget_minor)
RETURNING spent_minor;
```

Zero rows means the budget is spent; the award records `SKIPPED_BUDGET` rather
than vanishing.

**Cost needs a common unit.** Points and items are not currency, so the budget
is expressed in minor units and each rule carries a `budget_cost_minor` — what
the enterprise considers this award to cost them. A points award can cost zero
if they prefer to cap only real money. Without this, a budget means nothing for
two of the three reward kinds.

### 4.4 Ordering within the transaction

```
1. INSERT award (ON CONFLICT DO NOTHING) → no row means already processed, exit
2. Claim the frequency counter   → 0 rows → state = SKIPPED_CAP, COMMIT
3. Claim the program budget      → 0 rows → state = SKIPPED_BUDGET, COMMIT
4. Evaluate the formula, snapshot the signals
5. Write ledger entries + update wallet projection
6. Enqueue forwarding if configured
   COMMIT
```

Recording a skipped award rather than discarding it is deliberate. *"Why didn't
I get my points?"* is a question the enterprise will be asked, and
`SKIPPED_CAP` with a `period_key` answers it in one row.

---

## 5. Value mechanics

### 5.1 The ledger is the record; the balance is a projection

`reward_ledger_entries` is append-only and is the system of record.
`reward_wallets.balance` is a materialised projection written **in the same
transaction** as the entry, with a reconciliation job that recomputes from
entries and alarms on divergence. This is the strongest convergence in the
market study (§2) — no system that stores value ships a mutable balance column
with no entry log behind it.

Amounts are **signed `BIGINT`**, whole points or integer minor units. Never a
float, never a `NUMERIC` we are tempted to do arithmetic on in the application.

Enforcement is layered, because each layer alone is defeatable (study §2.2): no
UPDATE or DELETE path to entries exists in the repository, and a
`BEFORE UPDATE OR DELETE` trigger raises. Corrections are reversing entries.

### 5.2 Conversion — 30 points becomes ₹500

Burn and earn across two wallets, in one transaction, never a balance edit:

```sql
-- n = floor(balance / threshold), computed first, applied once
UPDATE reward_wallets
   SET balance = balance - (:n * :threshold)
 WHERE id = :points_wallet AND enterprise_id = :ent
   AND balance >= (:n * :threshold);
-- 0 rows => insufficient. Otherwise CONVERT_OUT + CONVERT_IN entries, same txn.
```

Computing `n` in one shot rather than looping while the balance allows avoids an
unbounded loop on a hot path, which our own guidelines forbid outright.

The two entries share a `conversion_group_id` so the pair is recoverable. A
conversion is **burn-then-earn, not a lot move** — the same semantics every
loyalty platform uses for transfers (study §7.2).

`mode` is `AUTO` (fires on every points earn) or `ON_REQUEST` (the customer
chooses). `AUTO` carries a trap the study found shipped in a vendor's own docs:
if auto-conversion runs before a tier or threshold check, it can consume the
balance that would have qualified the customer for something else. We have no
tiers in V1, so this is a note for whoever adds them, not a present bug.

### 5.3 Items are an entitlement, not a balance

A free portion of fries is not a number that goes up. It is an issued right with
a lifecycle: `ISSUED → RESERVED → REDEEMED`, or `EXPIRED` / `REVOKED`.

```
reward_entitlements(
  enterprise_id, id, customer_id, award_id,
  item_ref_id,              -- opaque in V1; the catalogue is a later table
  state, redemption_code,   -- unguessable, never derived from customer or item
  issued_at, expires_at, redeemed_at, reserved_until
)
```

**V1 writes these rows and nothing redeems them.** That is the deliberate seam:
the award path, the cap, the ledger and the audit trail are all exercised, and
the deferred work is the catalogue behind `item_ref_id` plus the redemption
endpoint. Neither touches anything above.

Redemption, when built, is the same reserve-then-commit pattern four independent
vendors converged on (study §5.2) — `RESERVED` with a TTL at point of sale,
`REDEEMED` on confirmation, a reaper releasing abandonments. Codes must be
unguessable and never derivable from the customer or the item: the study records
a 2014 case where a user replaced his referral code with a memorable one, seeded
it publicly, and collected over $50,000 (study §7.7).

### 5.4 Closed loop as a system property, not a policy

The money model is **enterprise liability, redeemable only with that
enterprise**. That keeps it outside the RBI PPI framework — value is redeemable
only against the issuing entity's own goods, cannot be withdrawn as cash, cannot
move to another user or a bank account, and never settles an obligation owed to
anyone else (study §14.1).

All four conditions must hold. Break one and the enterprise needs a Certificate
of Authorisation, which is ₹5 crore of net worth at application and a bank
escrow account with quarterly auditor certification.

The EBA makes the point that matters for us: **technical and contractual
restrictions are required cumulatively** — the system must be *incapable* of
settling outside the boundary, not merely forbidden from doing so (study §14.3).

So the boundary is enforced by absence, and these are the things we deliberately
do not build:

- **No cash-out path.** No endpoint converts a balance to a payout.
- **No customer-to-customer transfer.** No entry type moves value between two
  `customer_id`s.
- **No cross-enterprise wallet.** `enterprise_id` leads every key, so a wallet
  cannot span tenants.
- **No third-party settlement.** Value is only ever spent against the issuing
  enterprise.

**Each of these is a test that asserts the path does not exist**, not a comment
saying it should not. If a future requirement needs one, that is a product
decision with a regulatory consequence, and it should fail a test loudly on the
way in.

**Where Wouchh sits.** We record what the enterprise owes its customer. We do
not hold the money, and no float passes through us. That is the lightest posture
available and it is worth protecting — the alternative pulls escrow accounts,
daily reconciliation as a compliance obligation, and an RBI conversation into
scope (study §14.1, §14.4).

---

## 6. Schema

Conventions follow [`schema.md`](./schema.md) throughout: `BIGSERIAL` primary
keys, `enterprise_id BIGINT NOT NULL` leading every index, composite foreign
keys `(x_id, enterprise_id) → table(id, enterprise_id)`, `is_deleted` with
partial unique indexes, UTC timestamps.

### 6.1 `reward_programs`

| Column | Type | Notes |
| ------ | ---- | ----- |
| id | BIGSERIAL | PK |
| enterprise_id | BIGINT | NOT NULL, FK → `enterprises(id)` |
| name | VARCHAR(120) | NOT NULL |
| status | VARCHAR(16) | `DRAFT` / `ACTIVE` / `PAUSED` / `ENDED` |
| timezone | VARCHAR(64) | NOT NULL — resolves `period_key`. Defaults from the enterprise |
| currency_code | CHAR(3) | For currency rewards |
| budget_minor | BIGINT | NULL = uncapped |
| spent_minor | BIGINT | NOT NULL DEFAULT 0 |
| starts_at / ends_at | TIMESTAMPTZ | |
| is_deleted, created_at, updated_at | | |

```sql
CREATE UNIQUE INDEX reward_programs_name_uniq
  ON reward_programs (enterprise_id, lower(name)) WHERE is_deleted = false;
```

### 6.2 `reward_rules`

| Column | Type | Notes |
| ------ | ---- | ----- |
| id | BIGSERIAL | PK |
| enterprise_id, program_id | BIGINT | NOT NULL, composite FK |
| version | INTEGER | NOT NULL — rules are versioned, never edited in place |
| supersedes_rule_id | BIGINT | NULL for v1 of a rule |
| trigger_type | VARCHAR(40) | NOT NULL — from the catalogue |
| trigger_filters | JSONB | NOT NULL DEFAULT `'{}'` |
| award_mode | VARCHAR(10) | `FIXED` / `UP_TO` |
| reward_kind | VARCHAR(16) | `POINTS` / `CURRENCY` / `ITEM` |
| points | INTEGER | for `POINTS` |
| amount_minor | BIGINT | for `CURRENCY` |
| item_ref_id | VARCHAR(64) | for `ITEM` |
| signal_name | VARCHAR(40) | `UP_TO` only — must be valid for this trigger |
| formula_base / formula_rate_num / formula_rate_den | INTEGER | integer arithmetic only |
| formula_floor / formula_cap | INTEGER | the "up to" ceiling |
| on_signal_missing | VARCHAR(12) | `USE_FLOOR` / `USE_BASE` / `SKIP` |
| cap_scope | VARCHAR(10) | `LIFETIME`/`DAY`/`WEEK`/`MONTH`/`YEAR`/`NONE` |
| cap_count | INTEGER | NOT NULL DEFAULT 1 |
| budget_cost_minor | BIGINT | NOT NULL DEFAULT 0 — what this award costs the budget |
| hold_hours | INTEGER | NOT NULL DEFAULT 0 |
| reversal_policy | VARCHAR(20) | `NONE` / `ON_CONTENT_DELETED` |
| priority | INTEGER | deterministic ordering when several rules match |
| is_active, is_deleted, created_at, updated_at | | |

```sql
CREATE UNIQUE INDEX reward_rules_version_uniq
  ON reward_rules (enterprise_id, program_id, id, version);

-- the hot path: which active rules match this trigger, in deterministic order
CREATE INDEX reward_rules_trigger_idx
  ON reward_rules (enterprise_id, trigger_type, priority, id)
  WHERE is_active = true AND is_deleted = false;
```

**Rate as a numerator and denominator**, not a float: "1 point per 10 likes" is
`rate_num = 1, rate_den = 10`, evaluated in integer arithmetic. A `NUMERIC` rate
invites rounding drift into a value calculation, and the market study is
unambiguous that floats have no place in one (study §13.3).

**Rules are versioned because awards reference them.** Editing a rule in place
would silently rewrite the explanation of every past award. A change writes a
new version; the award keeps `rule_version`.

### 6.3 `reward_grant_counters`

| Column | Type | Notes |
| ------ | ---- | ----- |
| enterprise_id, program_id, rule_id, customer_id | BIGINT | NOT NULL |
| period_key | TEXT | NOT NULL — see §4.2 |
| used | INTEGER | NOT NULL |
| cap | INTEGER | NOT NULL — snapshotted from the rule at first claim |
| created_at, updated_at | | |

```sql
CREATE UNIQUE INDEX reward_grant_counters_uniq
  ON reward_grant_counters (enterprise_id, rule_id, customer_id, period_key);
```

This index **is** the frequency cap. There is no `is_deleted` here on purpose: a
cap row is a fact about a period, not a soft-deletable record, and making it
disappear would hand out a slot.

Rows older than the longest active `cap_scope` are sweepable — except
`LIFETIME`, which is never swept.

### 6.4 `reward_awards`

| Column | Type | Notes |
| ------ | ---- | ----- |
| id | BIGSERIAL | PK |
| enterprise_id, program_id, rule_id | BIGINT | NOT NULL |
| rule_version | INTEGER | NOT NULL — which version decided this |
| customer_id | BIGINT | NOT NULL, composite FK → `customers` |
| channel_id | BIGINT | composite FK → `channels` |
| source_ref_type | VARCHAR(20) | `message` / `post` |
| source_ref_id | BIGINT | NOT NULL |
| state | VARCHAR(20) | see below |
| reward_kind | VARCHAR(16) | copied from the rule at award time |
| points / amount_minor | | the **final** computed values |
| currency_code | CHAR(3) | |
| item_ref_id | VARCHAR(64) | |
| signal_snapshot | JSONB | the values the formula used, and when they were read |
| hold_until | TIMESTAMPTZ | |
| granted_at / reversed_at | TIMESTAMPTZ | |
| reason_code | VARCHAR(40) | why skipped, or why reversed |
| period_key | TEXT | which cap slot this consumed — the answer to "why not?" |
| is_deleted, created_at, updated_at | | |

**States:** `HELD` → `GRANTED` → `REVERSED`, with the terminal non-grants
`SKIPPED_CAP`, `SKIPPED_BUDGET`, `SKIPPED_SIGNAL`, `EXPIRED`.

```sql
CREATE UNIQUE INDEX reward_awards_source_uniq
  ON reward_awards (enterprise_id, rule_id, customer_id, source_ref_type, source_ref_id)
  WHERE is_deleted = false;

-- the grant sweep: awards whose hold has elapsed
CREATE INDEX reward_awards_due_idx
  ON reward_awards (enterprise_id, hold_until)
  WHERE state = 'HELD' AND is_deleted = false;

CREATE INDEX reward_awards_customer_idx
  ON reward_awards (enterprise_id, customer_id, created_at DESC)
  WHERE is_deleted = false;
```

### 6.5 `reward_wallets`

| Column | Type | Notes |
| ------ | ---- | ----- |
| id | BIGSERIAL | PK |
| enterprise_id, customer_id | BIGINT | NOT NULL, composite FK |
| wallet_kind | VARCHAR(16) | `POINTS` / `CURRENCY` |
| currency_code | CHAR(3) | NULL for points |
| balance | BIGINT | NOT NULL DEFAULT 0 — projection |
| pending_balance | BIGINT | NOT NULL DEFAULT 0 — held, not yet spendable |
| lifetime_earned | BIGINT | NOT NULL DEFAULT 0 — never decremented |
| version | BIGINT | NOT NULL DEFAULT 0 |
| is_deleted, created_at, updated_at | | |

```sql
CREATE UNIQUE INDEX reward_wallets_uniq
  ON reward_wallets (enterprise_id, customer_id, wallet_kind,
                     COALESCE(currency_code, '---'))
  WHERE is_deleted = false;
```

`COALESCE` in the index because `NULL` currency for points would otherwise
defeat uniqueness — two points wallets could coexist.

**One wallet per kind per currency, from day one.** Points and money are never
one number. Every mature platform splits these, and all of them lock the split
at program creation precisely because it cannot be retrofitted (study §3.1).
`lifetime_earned` is separated now so that tier-qualifying value, if it ever
arrives, has somewhere to live that spending does not reduce.

### 6.6 `reward_ledger_entries`

| Column | Type | Notes |
| ------ | ---- | ----- |
| id | BIGSERIAL | PK |
| enterprise_id, wallet_id | BIGINT | NOT NULL |
| entry_type | VARCHAR(20) | `EARN`/`BURN`/`CONVERT_OUT`/`CONVERT_IN`/`REVERSAL`/`ADJUST`/`TRANSFER_IN`/`TRANSFER_OUT` |
| amount | BIGINT | NOT NULL, **signed** |
| balance_after | BIGINT | NOT NULL — the projection at this point, for audit |
| award_id | BIGINT | provenance |
| rule_id, rule_version | | which rule caused this |
| conversion_group_id | UUID | pairs the two halves of a conversion |
| reverses_entry_id | BIGINT | |
| idempotency_key | TEXT | NOT NULL |
| actor_type / actor_id | | for `ADJUST` — who did it |
| reason_code | VARCHAR(40) | |
| occurred_at_utc / recorded_at_utc | TIMESTAMPTZ | business time vs system time |

```sql
CREATE UNIQUE INDEX reward_ledger_idem_uniq
  ON reward_ledger_entries (enterprise_id, idempotency_key);

CREATE UNIQUE INDEX reward_ledger_reversal_uniq
  ON reward_ledger_entries (enterprise_id, reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;      -- one reversal per entry, ever

CREATE INDEX reward_ledger_wallet_idx
  ON reward_ledger_entries (enterprise_id, wallet_id, id DESC);
```

**No `is_deleted`.** An append-only ledger has no delete, soft or otherwise, and
offering the column would invite someone to use it.

**Bitemporal.** `occurred_at_utc` is when it happened in the business sense —
when the comment was posted — and `recorded_at_utc` is when we learned. Webhooks
arrive late and out of order, and without both columns a late arrival cannot be
placed correctly in history (study §2.2).

### 6.7 `reward_entitlements`, `reward_conversion_rules`, `reward_destinations`, `reward_forward_outbox`

```sql
reward_entitlements(
  id, enterprise_id, customer_id, award_id, item_ref_id,
  state, redemption_code, issued_at, expires_at, reserved_until, redeemed_at,
  is_deleted, created_at, updated_at
)
CREATE UNIQUE INDEX reward_entitlements_code_uniq
  ON reward_entitlements (enterprise_id, redemption_code) WHERE is_deleted = false;

reward_conversion_rules(
  id, enterprise_id, program_id,
  from_wallet_kind, threshold_points,
  to_wallet_kind, to_currency_code, output_minor,
  mode,            -- AUTO | ON_REQUEST
  is_active, is_deleted, created_at, updated_at
)

reward_destinations(
  id, enterprise_id, program_id,
  kind,            -- INTERNAL | EXTERNAL
  provider_code,   -- 'noop' in V1; a real driver later
  config JSONB,    -- endpoint + mapping. NEVER the secret; a reference to it
  is_active, is_deleted, created_at, updated_at
)

reward_forward_outbox(
  id, enterprise_id, destination_id, ledger_entry_id,
  payload JSONB, state, attempts, next_attempt_at,
  last_error_code, external_ref, provider_code,
  created_at, updated_at
)
CREATE UNIQUE INDEX reward_forward_outbox_uniq
  ON reward_forward_outbox (enterprise_id, destination_id, ledger_entry_id);
CREATE INDEX reward_forward_outbox_due_idx
  ON reward_forward_outbox (enterprise_id, next_attempt_at)
  WHERE state IN ('PENDING', 'FAILED');
```

`config` holds a **reference** to a credential, never the credential. Secrets go
where the rest of ours go.

---

## 7. The forwarding seam

Earnings either stay in Wouchh or go to a system the enterprise already runs.
The integration does not exist yet, so V1 ships the seam.

```ts
interface ForwardingProvider {
  readonly code: string;
  forward(entry: LedgerEntry, config: DestinationConfig): Promise<ForwardResult>;
}
```

V1 registers exactly one implementation, `NoopForwardingProvider`, which does no
I/O and reports success.

**The rule that makes the later integration cheap:**

> **The ledger is written regardless of destination. An external system is a
> mirror, never the record.**

So an award never fails because someone's loyalty API is down, we always know
what we granted even if nothing was ever delivered, and adding a real provider
is registering a driver behind `provider_code` with no change to the award path.
The outbox follows the `FOR UPDATE SKIP LOCKED` polling pattern already in this
codebase — **no new infrastructure** (study §6.4).

### 7.1 A stub that reports success must be auditably a stub

This is the part worth being careful about. A no-op that writes
`state = 'SENT'` is indistinguishable, six months and fifty thousand rows later,
from value that genuinely reached an external system. Someone will eventually
ask *"did these actually go out?"* and the honest answer will be unavailable.

So:

- The outbox row records `provider_code = 'noop'`, persisted per row rather than
  looked up from the destination, because the destination's provider will change
  when the real one lands and the history must not silently re-label itself.
- The terminal state for a stub is **`SENT_STUB`**, not `SENT`.
- `external_ref` stays `NULL` — there is no remote id, and inventing one would
  be fabricating a receipt.
- Switching a destination from `noop` to a real provider does **not** backfill.
  Rows already `SENT_STUB` stay that way. Whether to replay them is an explicit
  decision at that point, with its own double-grant risk on the far side.

Our own rule against silently swallowing anything applies: a stub that looks
like a success is a swallowed failure with better manners.

---

## 8. Holds, reversal, and content that disappears

Social content is deletable, and a reward tied to content that no longer exists
is a reward the enterprise paid for nothing.

`hold_hours` on the rule sets the window. During it the award is `HELD`, the
value sits in `pending_balance`, and it is not spendable. At expiry the formula
is evaluated (§3.4), the ledger entry is written and the balance moves.

**Expiry is not deletion.** An Instagram story vanishing after 24 hours is the
story working correctly; a story being deleted at hour three is the signal we
care about. Conflating them would claw back from every honest customer who
mentioned us in a story, which is every one of them. Only an explicit delete or
removal — a `comment` deletion webhook, a post removed on re-sync — triggers
`ON_CONTENT_DELETED`.

Reversal writes a `REVERSAL` entry, never a delete or an in-place edit, and
decrements the frequency counter with `GREATEST(used - 1, 0)`.

**Balances may go negative, and that is a deliberate policy rather than an
error.** If a customer spends 20 points and the underlying comment is then
deleted, the clawback has nowhere to land. Three independent platforms model
this as a configurable flag rather than a crash (study §3.5), and the invariants
that make it safe are worth copying exactly:

- A negative balance takes effect immediately and **never expires** — a clawback
  that could itself expire is an exploit.
- **Rule evaluation can never drive a balance below zero.** Only reversals and
  manual adjustments can. Earning and spending stay ordering-safe; clawback is a
  privileged operation.
- A negative balance is offset automatically by the next earn, in the same
  transaction.

### 8.1 Customer merge

`customers.merged_into_customer_id` exists as a forward seam and nothing sets it
in V1 ([`schema.md` §16](./schema.md)). When merging arrives, wallets merge by
writing `TRANSFER_OUT` and `TRANSFER_IN` entries — **not** by repointing
`customer_id` on existing rows, which would break the audit trail at exactly the
point someone is asking why a balance changed.

Frequency counters are the harder half: merging two customers who each used
their lifetime slot must not grant a fresh one. The survivor keeps
`MAX(used)` per `(rule_id, period_key)`, not the sum. Worth writing down now
because it is not obvious later.

---

## 9. Abuse

"Post a story about us for 20 points" is directly farmable, and the honest
framing is that V1 ships **controls, not detection.**

What the design already gives us: a per-customer frequency cap that is a
constraint rather than a check, a program budget that fails closed, a hold
before value is spendable, and an append-only ledger that makes an incident
reconstructable.

What it does not give us: anything against **ten accounts** rather than one.
That is the referral-ring pattern, and the market study is clear that it is a
graph problem — shared-attribute linking, IDF-weighted hubs, synchrony
clustering (study §16.3). It is also clear that naive versions of it flag most
of your customers (*"it is not wrong about the links; it is wrong about what a
link means"*).

Two things we get for free and should not squander:

- **Platform-scoped ids make Sybil accounts expensive.** Creating a second
  Instagram account to farm a reward is real work with a real phone number,
  which is a better barrier than most programs have.
- **We hold the interaction history.** `customer_engagements` already knows when
  someone first appeared. A rule filter of *"account must have engaged before
  today"* is a cheap, high-value control that needs no new data.

The recommendation is to defer detection and **keep the hook**: awards carry a
`reason_code` and a state, so a review queue is a state and a screen rather than
a schema change.

---

## 10. What V1 builds, and what it stubs

| Area | V1 |
| ---- | -- |
| Programs, rules, versioning | **Built** |
| Trigger catalogue + normaliser | **Built** — `POST_CAPTION_MENTION` present but inert until E8 |
| Formula evaluation + signal registry | **Built** — not offered for `STORY_MENTION` or `DM_INBOUND` (§3.3) |
| Frequency caps, program budget | **Built** |
| Points wallet + ledger | **Built** |
| Currency wallet + ledger | **Built** |
| Conversion rules | **Built** |
| Entitlements | **Rows written**, catalogue and redemption deferred |
| Forwarding | **Seam + `noop` provider**, real driver deferred |
| Reversal, holds, negative balance | **Built** |
| Review queue / fraud detection | **Not built** — hook preserved |
| Tiers, expiry, breakage accounting | **Not built** — see the market study if they arrive |

Deliberately **not** built, and enforced by tests asserting the path is absent:
cash-out, customer-to-customer transfer, cross-enterprise wallets, third-party
settlement (§5.4).

### 10.1 Suggested build order

1. **Schema + ledger + wallet,** with the reconciler and the immutability
   trigger. Nothing above it works without this and everything above it is
   easier to test against it.
2. **Trigger normaliser + event catalogue.** Mapping real `messages` and `posts`
   rows to normalised events, with no rules attached yet.
3. **Rules, caps, the award state machine.** Points only, fixed amounts.
4. **Formula evaluation + the signal registry.**
5. **Currency, conversion, entitlement rows.**
6. **Forwarding seam + `noop`.**
7. **FE:** program and rule builder, customer balance view, award history.

Each step is shippable and independently testable, and the first three are where
the correctness lives.

---

## 11. Open questions

**Resolved by decision, recorded so the reasoning survives:** variable awards
use a formula rather than manual review; money is enterprise liability
redeemable only with that enterprise; V1 carries the full config surface with
forwarding and item redemption stubbed.

**Still open:**

1. **`STORY_MENTION` cannot carry a formula** (§3.3). Confirm a fixed award is
   acceptable for the trigger most likely to be used, or decide whether this
   justifies revisiting the Instagram permission scope.
2. **`budget_cost_minor` for points and items** — what does the enterprise
   consider a 20-point award to cost? Without an answer the budget guards only
   currency.
3. **Who may adjust a balance manually,** and under which permission.
   `ADJUST` entries exist in the ledger; the RBAC entry does not yet.
4. **Retention.** Ledger entries are financial records and should outlive the
   30-day transport ledger window. Awards and counters likely follow the
   customer record. Not yet decided.
5. **What the customer sees.** Nothing in this design surfaces a balance to the
   end customer — it is visible to the enterprise. If customers are meant to see
   their own points, that is a separate authenticated surface and a different
   conversation.
