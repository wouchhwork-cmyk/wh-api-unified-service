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

## 3. Triggers — the catalogue, audited against the handlers

### 3.1 What we actually subscribe to and consume

This is taken from `SUBSCRIBED_FIELDS` in `graph-api.client.ts` and the
projectors that consume each one, not from the product description. The first
draft of this catalogue was written from memory of the feature and missed more
than half of it.

| Subscribed field | Consumed by | Is it a customer action? | Reward trigger |
| ---------------- | ----------- | ------------------------ | -------------- |
| `messages` | DM projector | Yes | `DM_INBOUND`, `STORY_REPLY`, `STORY_MENTION` |
| `message_reactions` | `handleReaction` | Yes | `MESSAGE_REACTION` |
| `messaging_postbacks` | `postbackAsMessage` | Yes — tapped a button | `POSTBACK_TAPPED` |
| `messaging_optins` | DM projector | Yes — gave consent | `OPTIN_GRANTED` |
| `messaging_referrals` | `platformFacts.referral` | Yes — arrived via ad / ref / QR | `REFERRAL_ENTRY` |
| `feed` (`item=comment`) | comment projector | Yes | `COMMENT_ON_OWN_POST` |
| `feed` (`item=like`) | **routed to post projector, not modelled** | Yes | `POST_LIKE` — see §3.4 |
| `feed` (`item=share`) | post projector | Yes | `POST_SHARE` — see §3.4 |
| `feed` (other items) | post projector | No — our own publishing | — |
| `mention` | mention flow | Yes | `POST_TAGGING_US`, `POST_CAPTION_MENTION`, `COMMENT_ON_MENTIONED_POST` |
| `message_echoes` | DM projector | **No — that is us** | Never |
| `message_reads` | subscribed | **No — a read receipt** | Never, see §3.3 |
| `message_edits` | `handleEdit` | Yes, but not new engagement | Never, see §3.3 |

Instagram arrives on the app-level `instagram` object with `comments`,
`mentions` and `messages`, routed through the same projectors.

### 3.2 The catalogue

| Trigger | Source | Note |
| ------- | ------ | ---- |
| `DM_INBOUND` | `messages` | |
| `STORY_REPLY` | `messages`, `MessageKind.StoryReply` | They replied to **our** story |
| `STORY_MENTION` | `messages`, attachment `story_mention` | They mentioned us in **their** story |
| `MESSAGE_REACTION` | `message_reactions` | They reacted to something we sent |
| `POSTBACK_TAPPED` | `messaging_postbacks` | Ice breaker or template button. Filterable on `payload` |
| `OPTIN_GRANTED` | `messaging_optins` | A consent event, not a message |
| `REFERRAL_ENTRY` | `messaging_referrals` | Filterable on `ref`, `source`, `type`, `ad_id` |
| `COMMENT_ON_OWN_POST` | `feed` / `comments` | `is_reply` filter separates top-level from replies |
| `COMMENT_ON_MENTIONED_POST` | `mention` | Comment on someone else's post that tags us |
| `POST_TAGGING_US` | `mention` | |
| `POST_CAPTION_MENTION` | `mention` | Inert until E8 — see §3.3 |
| `POST_LIKE` | `feed` `item=like` | **Needs work first — §3.4** |
| `POST_SHARE` | `feed` `item=share` | **Needs work first — §3.4** |

**`REFERRAL_ENTRY` deserves attention.** `messaging_referrals` carries `ref`,
`source`, `type` and `ad_id`, and we already store the whole object on
`platformFacts`. That is the primitive behind "scan this QR code in store and
get 50 points" and "message us from this ad for a welcome reward" — two of the
most common loyalty mechanics in existence — and it needs no new integration
work at all. It was missing from the first draft of this document and is
probably the most valuable trigger in the list.

**`POSTBACK_TAPPED` is the other quiet one.** A postback carries a `payload` set
when the button was defined, so a rule can match a specific button. That makes
"tap here to claim" a first-class flow rather than something built out of
keyword matching on free text.

### 3.3 What is deliberately excluded, and why

Not every consumed event should be able to earn.

- **`message_echoes`** — the sender is us. Rewarding it would pay the customer
  for our own activity.
- **`message_reads`** — a read receipt is not an achievement, and it is
  trivially farmable by opening a thread repeatedly. It is also the weakest
  signal of intent we hold.
- **`message_edits`** — editing is not new engagement, and allowing it to earn
  creates a re-trigger attack: post once, edit fifty times. The unique index in
  §4.1 would stop a *repeat* award for the same rule, but the right answer is
  that the trigger should not exist.
- **Post verbs other than `add`** — `edit`, `hide` and `remove` are reversal
  signals, not earning signals. See §3.5.
- **`PermissionChange`** — infrastructure, not customer activity.
- **`POST_CAPTION_MENTION`** fires only if mention monitoring is resolved
  ([`todo.md`](./todo.md) **E8**, parked as a commercial decision). The rule type
  should exist and award nothing rather than appear later as a schema change.

### 3.4 Likes and shares need work before they can earn

The webhook already arrives. `feed` covers "posts, photos, videos, shares,
likes and comments, discriminated by `value.item`" — that is a comment in our
own `meta-webhook.service.ts`, written when routing the whole field to the
comment projector turned out to be a bug.

But **`item: 'like'` is not modelled anywhere.** The string appears nowhere in
`src/` outside `like_count`. A like change is routed to the post projector,
where `toPostKind` falls through to `PostKind.Text`, and the event is treated as
a change to the post rather than as a person having liked it. **We are told who
liked a post and we throw away the fact.**

That is a small, self-contained piece of work — capture the actor and the verb
from a `like` feed change — and it unlocks the single most obvious reward
trigger an enterprise will ask for on day one. It should be scoped before anyone
promises `POST_LIKE` in the UI. The same is true of `share`, with the extra
caveat that Facebook's share visibility depends on the sharer's audience.

Two caveats worth stating before anyone builds the rule: a like is **Facebook
only** on this path, and likes are **retractable**, so `POST_LIKE` needs
`ON_CONTENT_DELETED`-style reversal on the `remove` verb or it is free money.

### 3.5 Reversal signals already exist

`extractVerb` pulls `add` / `edit` / `hide` / `remove` off a feed change and
makes the verb part of the dedup key, and `applyModeration` already applies the
result to a stored comment.

So the deletion signal my reversal policy needs is not new work — it is a
consumer of something already flowing:

| Verb | Meaning | Reward consequence |
| ---- | ------- | ------------------ |
| `add` | created | the earning event |
| `edit` | content changed | none — see §3.3 |
| `hide` | **the enterprise hid it** | reverse: they judged it unwanted |
| `remove` | **deleted** | reverse: the thing we paid for is gone |

`hide` is the interesting one. An enterprise hiding a comment is an explicit
judgement that it was not the engagement they wanted, and it is the cheapest
abuse signal available — it costs them a click they were going to make anyway.

### 3.6 The award factor

`UP_TO` rules declare a **cap**. A separate factor provider returns a value in
`[0, 1]`, and the award is that fraction of the cap:

```
award = round(cap × factor)        factor ∈ [0, 1]
```

**V1 ships `constant_one`, which returns 1.0** — so `UP_TO` awards the full cap
and behaves identically to `FIXED`. The real provider is a rule engine that
lands later and returns a genuine factor.

This is the same seam as forwarding (§7), and it is a better design than the
rate table that was here before, for three reasons:

1. **It removes the signal problem entirely.** The previous design scaled the
   award against a platform metric, and the metrics we can read do not cover the
   triggers that matter — insights and `business_discovery` both refuse with
   Graph `#10`, so a story someone else posted has no readable reach at all.
   `STORY_MENTION` had to be excluded from variable awards. With a factor
   provider, the trigger needs no signal and nothing is excluded.
2. **The cap is the only number the enterprise configures.** "Up to 20 points"
   means exactly that, in one column, with no base, rate, floor or
   missing-signal policy to reason about.
3. **The provider can become arbitrarily clever without touching anything
   here.** Content quality, sentiment, reach when we can finally read it,
   customer history — all of it lands behind one interface that returns a
   number between zero and one.

**Integer arithmetic, as everywhere else in this design.** The factor is carried
as basis points, `factor_bp ∈ [0, 10000]`:

```
award = (cap × factor_bp + 5000) / 10000      -- integer division, round half up
```

The provider's output is **clamped to `[0, 10000]` on the way in**. A provider
returning 1.5 must not award 30 points against a cap of 20, and the clamp
belongs at the boundary rather than in the provider, because the provider is the
thing most likely to change.

**Evaluated at grant time**, not event time — the end of the hold period — so a
future provider that reads engagement has had time for the numbers to settle.
`factor_bp`, the provider code and the evaluation timestamp are snapshotted onto
the award, because an award nobody can explain is an award the enterprise cannot
defend to its customer.

**A zero factor does not consume the cap slot.** If a provider decides an
interaction is worth nothing, the customer has not earned, and burning their
once-per-lifetime slot would be the wrong outcome. The award records
`SKIPPED_ZERO_FACTOR` and the counter is released with the same
`GREATEST(used - 1, 0)` decrement used for reversal. With `constant_one` this
path is unreachable in V1, which is a good reason to test it now rather than
when the real provider makes it live.


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

### 5.1 One customer holds several balances at once

A customer may hold a **points balance and one or more currency wallets
simultaneously** — 340 points, ₹250, and $12, all at the same time. This is the
normal case, not an edge case, and the schema is shaped for it from the start
rather than growing into it.

```
customer 8812 ──┬── wallet  POINTS            balance 340
                ├── wallet  CURRENCY / INR    balance 25000   (= ₹250.00)
                └── wallet  CURRENCY / USD    balance   1200   (= $12.00)
```

The uniqueness key is `(enterprise_id, customer_id, wallet_kind, currency_code)`,
so a customer gets exactly one wallet per kind per currency and as many as the
programs they participate in require (§6.5).

**The two scales are different, and `wallet_kind` is what says which.**

| Kind | `amount` means | Scale |
| ---- | -------------- | ----- |
| `POINTS` | **whole points** | No minor unit. 340 is 340 points, never 3.40 |
| `CURRENCY` | **minor units** | 25000 with `INR` is ₹250.00 |

Both are `BIGINT`. Neither is ever a float, a `NUMERIC`, or a value the
application divides before storing.

**Three invariants that follow, and they are not negotiable:**

1. **Never net across wallets.** There is no "total balance". A customer with
   340 points and ₹250 has two numbers, and any screen, API response or export
   that collapses them into one is wrong. Points are not currency and two
   currencies are not each other.
2. **Minor-unit scale comes from the currency, never from a constant.** The
   ISO 4217 exponent is 0 for JPY, KRW and VND, 2 for INR and USD, and 3 for
   KWD and BHD. A hardcoded ×100 is wrong for a meaningful share of the world
   and will be wrong silently (study §13.3). Formatting reads the exponent; it
   is never assumed.
3. **No implicit FX.** Nothing in this design converts one currency into
   another. A rule awards in a stated currency and it lands in that wallet. If
   cross-currency ever becomes a requirement it arrives as explicit postings
   with the rate stored on the transaction — not as a division somewhere in a
   service.

**Where the currency is decided.** A rule carries `currency_code` for
`CURRENCY` rewards, defaulting from its program. That allows an enterprise
operating in two countries to run programs in ₹ and $ without either a second
tenant or a wallet that lies about what it holds.

### 5.2 The ledger is the record; the balance is a projection

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

### 5.3 Conversion — 30 points becomes ₹500

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

### 5.4 Items are an entitlement, not a balance

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

### 5.5 Closed loop as a system property, not a policy

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
| default_currency_code | CHAR(3) | Default for currency rules. A rule may state another |
| budget_minor | BIGINT | NULL = uncapped |
| budget_currency_code | CHAR(3) | Which currency the budget is counted in |
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
| award_cap | INTEGER | `UP_TO` only — the ceiling the factor is applied to |
| factor_provider_code | VARCHAR(40) | NOT NULL DEFAULT `'constant_one'` |
| currency_code | CHAR(3) | `CURRENCY` rewards; defaults from the program (§5.1) |
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

**No formula columns, by design.** A variable award is a cap plus a provider
code; the arithmetic lives in one place (§3.6) and the provider is swappable
without a migration. `factor_bp` is an integer in basis points because a
`NUMERIC` or float factor would put rounding drift into a value calculation, and
the market study is unambiguous that floats have no place in one (study §13.3).

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
| factor_bp | INTEGER | `0..10000`, post-clamp. NULL for `FIXED` |
| factor_provider_code | VARCHAR(40) | which provider produced it |
| factor_computed_at | TIMESTAMPTZ | when — the metric moves, the snapshot must not |
| hold_until | TIMESTAMPTZ | |
| granted_at / reversed_at | TIMESTAMPTZ | |
| reason_code | VARCHAR(40) | why skipped, or why reversed |
| period_key | TEXT | which cap slot this consumed — the answer to "why not?" |
| is_deleted, created_at, updated_at | | |

**States:** `HELD` → `GRANTED` → `REVERSED`, with the terminal non-grants
`SKIPPED_CAP`, `SKIPPED_BUDGET`, `SKIPPED_ZERO_FACTOR`, `EXPIRED`.

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
| wallet_kind | VARCHAR(16) | `POINTS` / `CURRENCY` — decides how `balance` is read |
| currency_code | CHAR(3) | NULL for points; ISO 4217 for currency |
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
| amount | BIGINT | NOT NULL, **signed**. Whole points or minor units — the wallet's kind decides (§5.1) |
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
| Award factor | **Seam + `constant_one` provider** returning 1.0 — real engine deferred, backlog §8.1 |
| Frequency caps, program budget | **Built** |
| Points wallet + ledger | **Built** |
| Currency wallet + ledger | **Built** |
| Conversion rules | **Built** |
| Entitlements | **Rows written**, catalogue and redemption deferred |
| Forwarding | **Seam + `noop` provider**, real driver deferred |
| Reversal, holds, negative balance | **Built** |
| `POST_LIKE` / `POST_SHARE` triggers | **Not built** — the webhook arrives but a like is not modelled, backlog §8.2 |
| Review queue / fraud detection | **Not built** — hook preserved |
| Tiers, expiry, breakage accounting | **Not built** — see the market study if they arrive |

Deliberately **not** built, and enforced by tests asserting the path is absent:
cash-out, customer-to-customer transfer, cross-enterprise wallets, third-party
settlement (§5.5).

### 10.1 Suggested build order

1. **Schema + ledger + wallet,** with the reconciler and the immutability
   trigger. Nothing above it works without this and everything above it is
   easier to test against it.
2. **Trigger normaliser + event catalogue.** Mapping real `messages` and `posts`
   rows to normalised events, with no rules attached yet.
3. **Rules, caps, the award state machine.** Points only, fixed amounts.
4. **The factor seam** — `FactorProvider`, `constant_one`, the clamp, the
   snapshot on the award, and the zero-factor release path tested even though
   `constant_one` cannot reach it.
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

1. **What the factor engine should actually measure** (§3.6). The seam is
   defined and `constant_one` ships; the inputs, the weighting and whether it is
   per-trigger or global are open. Recorded as backlog §8.1.
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
