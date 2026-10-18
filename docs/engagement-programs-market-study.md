# Engagement Programs — Technical Market Study

How loyalty, coupons, stored-value wallets and referrals are structured and
architected in systems that run at scale worldwide — what the market has
converged on, where it disagrees, and why.

This is **research, not a design decision**. Nothing here has been built, and the
Wouchh section at the end is a reading of the evidence against our codebase, not
a plan anyone has signed off. Where the research disagrees with itself, or could
not establish something, that is stated rather than smoothed over.

Compiled October 2026 from vendor developer documentation, machine-readable API
specs, SEC filings, peer-reviewed papers, regulatory primary sources and
published CVEs. §18 lists what could not be verified; §19 is the source list.

---

## 1. Why these four are one problem

Loyalty points, discount codes, wallet balances and referral rewards look like
four products. Architecturally they are one system with four policy
configurations on top of it.

Every platform examined — Talon.One, Voucherify, Salesforce Loyalty Management,
Square, Shopify, commercetools, Capillary, Antavo, Zinrelo, Open Loyalty, Toast,
Lightspeed, Medusa, Saleor, Vendure, Elastic Path — converges on the same
five-part decomposition. Not merely the same vocabulary: **the boundaries fall in
the same places.**

```
Profile / Member  →  Event Stream  →  Rules Engine  →  Effects  →  Value Ledger
```

| Part | Talon.One | Voucherify | Salesforce | Square | Open Loyalty |
| ---- | --------- | ---------- | ---------- | ------ | ------------ |
| Profile | Customer Profile | customer + member | LoyaltyProgramMember | LoyaltyAccount | Customer aggregate |
| Events | `/v3/events` | `/v1/events` | TransactionJournal | LoyaltyEvent | Commands → Events |
| Rules | Campaign → Ruleset | Campaign + Earning Rule | Program Process | `accrual_rules` | EarningRule |
| Effects | `effects[]` | redeemables | configured actions | points/rewards | events + webhooks |
| Ledger | LoyaltyLedgerEntry | card transactions | LoyaltyLedger | LoyaltyEvent log | PointsTransfer |

**One caveat against this thesis, raised by the research itself.** Standalone
engines (Talon.One, Voucherify, Open Loyalty) are *forced* to externalise all
five parts as API-visible concepts, because they do not own the surrounding
system. Salesforce and Square, embedded in larger platforms, blur profile and
ledger into platform objects. The decomposition is genuinely common, but it is
sharpest precisely where the engine does not own the cart. That is the position a
standalone multi-tenant engagement service occupies, so the shape transfers — but
it is worth knowing the sample is not neutral.

---

## 2. The ledger is the spine

**In every system that stores value, the authoritative record is an append-only
entry log and the balance is a projection.** This is the strongest convergence in
the whole study. Nobody serious ships a mutable balance column.

The entry shape converges too. Talon.One's, from its OpenAPI spec, is the one
worth copying:

```
transactionUUID · created · type (addition | subtraction) · amount
startDate (immediate | on_action | <timestamp>)
expiryDate (unlimited | <timestamp>) · validityDuration
subledgerId · rulesetId · ruleName · customerSessionId · programId
```

Note the last four. **The ledger records which rule caused the movement.** That
is what lets anyone answer "why does this customer have these points?" eighteen
months later, and it is an underrated operational requirement — the first
question support asks and the hardest to answer retroactively.

The balance is never one number:

```
LoyaltyBalance { activePoints, pendingPoints, spentPoints, expiredPoints, negativePoints }
LoyaltyBalances { balance, subledgerBalances: { "<subledgerId>": LoyaltyBalance } }
```

Square states the rule most plainly: "Square creates a searchable loyalty event
**each time the balance changes**." Voucherify's transaction types are the same
idea with an explicit enum — `POINTS_ACCRUAL`, `POINTS_ADDITION`,
`POINTS_REMOVAL`, `POINTS_REDEMPTION`, `POINTS_REFUND`, `POINTS_EXPIRATION`,
`POINTS_TRANSFER_OUT` — and a `related_transaction_id` that pairs the two halves
of a transfer, which is double-entry by another name.

### 2.1 Derived, cached, or both

Three strategies are viable, and the consensus across Modern Treasury, Formance
and Uber's payments platform is that entries are the source of truth and any
stored balance is a rebuildable view:

1. **Pure aggregation** — `SUM(entries)` at read time. Strictly correct, makes
   point-in-time queries trivial (`WHERE posted_at <= t`), read cost unbounded.
2. **Materialised running balance** — maintained in the *same transaction* as the
   entry insert. Formance's refinement: store cumulative `posted_debits` and
   `posted_credits` as separate monotonically-increasing counters and derive the
   net, because a single net figure destroys activity-volume information.
3. **CQRS hybrid** — immutable log as write model, materialised index as read
   model, periodic snapshot and replay to prove them equal.

What everyone agrees you must *not* do is a mutable `balance` column with no
entry log behind it. Drift from a failed transaction then has no audit trail to
recover from.

**Practical answer: option 2, plus a reconciliation job that recomputes from
entries and alerts on divergence.** Treat divergence as a sev-1, not a cleanup
task.

### 2.2 Immutability has to be layered

Each layer alone is defeatable:

- **Application** — no UPDATE/DELETE path to entries exists in code. Corrections
  are reversing entries or delta entries.
- **Database** — `BEFORE UPDATE OR DELETE` trigger that raises. Postgres has no
  native append-only mode, so you build it. Plus separate roles: the migrator
  owns the schema, the application role has INSERT-only on entries and cannot
  drop triggers.
- **Balanced-posting constraint** — reject any transaction whose entries do not
  sum to zero. Uber runs this as a pre-commit validation on every money order.
- **Closed periods** — block postings dated into a period already reported.
- **Bi-temporality** — store both `recorded_at` (when you learned) and
  `effective_at` (when it economically happened). Without this, settlement lag
  makes historical restatement impossible, and offline POS traffic arriving
  "late, in bursts, and out of order" cannot be processed correctly.

### 2.3 Hash chaining, and its honest limit

Each entry stores `prev_hash` and a per-stream `sequence_no`. The hash must cover
everything that changes meaning — amount, both account ids, currency, effective
timestamp, external reference, and `prev_hash`. Omitting context fields is the
standard bug. A `sequence_no` gap independently catches a deleted middle row.

**But a hash chain alone does not stop a privileged attacker**, who can drop the
trigger, rewrite a row, recompute every subsequent hash and restore the trigger.
Tamper-evidence only becomes real with **external anchoring** — publishing signed
chain-head digests on a schedule to somewhere the DBAs cannot reach (a separate
account/KMS, an auditor, a transparency log). AWS QLDB was exactly this model
(SHA-256-linked journal blocks, Merkle tree, exportable digest); AWS has
end-of-lifed the product, so do not architect onto it, but the pattern survives.

Compute hashes inside the database or a trusted service, never client-side, and
test the trigger-disabled scenario explicitly — that is where naive chains fail.

---

## 3. Five things that cannot be retrofitted

Each of these came from a different research thread, independently. They share
one property: **the information needed to reconstruct them later does not exist
later.** Get them wrong and the fix is a data archaeology project, or impossible.

### 3.1 Split the value into separate accounts

Two different domains reached the same conclusion from opposite directions.

**Wallets.** Cash-funded, promotional and refund-sourced balances must be
separate ledger accounts:

| Code | Account | Normal | Why separate |
| ---- | ------- | ------ | ------------ |
| 1000 | Bank / Escrow | Debit | In India, literally the RBI-mandated escrow account |
| 1100 | PSP in-transit | Debit | Captured, not yet settled. Must drain to ~0 |
| 2000 | Customer wallet — **cash funded** | Credit | Real money. Refundable, escrow-backed, escheatable |
| 2010 | Customer wallet — **promotional credit** | Credit | Issuer-funded. Non-refundable, expires, usually not escheatable |
| 2020 | Customer wallet — **refund credit** | Credit | Legally ambiguous in every jurisdiction |
| 2100 | Unredeemed gift card liability | Credit | Different breakage and escheat treatment |
| 2400 | Escheat payable | Credit | Owed to states under unclaimed property law |
| 4000 | Breakage revenue | Credit | |
| 6000 | Promotional expense | Debit | Funds 2010 |
| 9000 | Suspense / unreconciled | Either | **Must be zero at period close** |

If 2000/2010/2020 are one integer, you can never afterwards answer *"how much of
this wallet is real customer money?"* — needed for refunds, escrow sizing,
escheat reporting and breakage revenue recognition. It cannot be reconstructed.

The invariant to monitor: `sum(2000) + sum(2100) <= balance(1000)`. In India this
is not a nicety — RBI ¶12.3(ii) requires day-end escrow to be at least
outstanding PPIs plus payments due to merchants, certified quarterly by statutory
auditors.

**Loyalty.** Spendable points and tier-qualifying points are **different
currencies**. IATA states it flatly: *"Status points have no redemption value.
They are simply a tracking mechanism to measure progress towards the achievement
of certain levels of status."* Salesforce encodes it as
`LoyaltyProgramCurrency.CurrencyType ∈ {Qualifying, NonQualifying}`, with a
separate `ExpiryModel` per currency and a `TierAssessmentCurrencyId` naming which
balance drives tiers.

**Conflate them and spending points demotes the member.** That is the single most
common data-model error in loyalty.

Multi-wallet is near-universal, not advanced: Talon.One sub-ledgers, Voucherify
point wallets (up to 10 per program), Open Loyalty wallets, Capillary alternate
currencies, Emarsys status vs spend points. **Note that the vendors lock this at
creation** — Talon.One's sub-ledger flag cannot be changed after program
creation, and Voucherify forbids adding wallets once a program is `ACTIVE`. They
know it cannot be retrofitted either.

### 3.2 Points with expiry force lot accounting

Points are not fungible. Each grant is a lot with its own start and expiry date,
and redemption must choose lots. Three systems say so independently:

- Square — "Redemptions use the points that expire soonest."
- Voucherify — "The removal of points will consume the points that expire the soonest."
- Talon.One — per-entry `startDate`/`expiryDate`/`validityDuration`, with
  dedicated `setLoyaltyPointsExpiryDate` and `extendLoyaltyPointsExpiryDate` effects.

**Earliest-expiry-first is not FIFO**, and conflating them is the central expiry
bug. They diverge whenever lots have heterogeneous TTLs: promotional points with
a 30-day life earned *after* base points with a 12-month life must burn first, or
they expire while the member holds a positive balance.

The actuarial literature (Casualty Actuarial Society) names three disciplines —
FIFO, LIFO, and **Average Weighted Cost, the "Piggy Bank" method**, where issue
time is ignored entirely, often *"due to actual database constraints making them
unavailable."* Under piggy-bank you permanently lose the ability to identify when
a redeemed or forfeited point was issued, which forecloses cohort-based liability
modelling forever. It is a schema shortcut with a Finance consequence.

### 3.3 Capture provenance at write time

Rule id on every ledger entry. PSP charge/authorisation/capture/settlement/payout
identifiers at the moment of posting, because settlement files use their own
batch references that rarely match yours and the mapping generally cannot be
reconstructed later. Purchaser address at issuance, because escheat priority
depends on it. Funding source on every promotion, because it changes the tax base
(§7.4). Last-activity timestamp, because every dormancy clock in every
jurisdiction runs off it and you must be able to *evidence* it.

This is the same standing rule we already apply to Meta fields: a field not
captured on arrival usually cannot be captured afterwards.

### 3.4 A ledger write path that bypasses the rules engine

With caller-supplied start and expiry dates and a `reason`. Talon.One's loyalty
import is a CSV of
`customerprofileid,amount,startdate,expirydate,subledgerid,reason`, and
"imported points are added to potential existing points."

Migration, support credits, dispute resolution and goodwill gestures are not rule
outputs. **If the only way to write a ledger entry is through the engine, you
cannot migrate onto your own platform.**

### 3.5 Negative balance is a policy, not an error

Square `allow_negative_balance` (default rejects with `400 BAD_REQUEST`),
Salesforce `DoesAllowNegativeBalance` (default false), Talon.One `negativePoints`
plus a `createsNegativeBalance` ledger flag. Three teams independently concluded
that refunds and corrections *will* drive balances below zero and the system must
decide deliberately rather than crash.

Talon.One's clawback mechanism is the most precisely specified: it splits into
**two** ledger transactions — `rollbackAddedLoyaltyPoints` deducts all active
points to exactly zero, then `addNegativeLoyaltyPoints` records the remainder.
A customer holding 50 active points against a 70-point clawback gets a −50
transaction and a −20 transaction, ending at −20.

The invariants that make it safe:

- **Negative points take effect immediately and do not expire.** A clawback that
  could itself expire is an exploit.
- **Rule evaluation can never push a balance below zero** — only rollbacks and
  manual deductions can. Normal earn/burn stays total-ordering-safe; clawback is
  a privileged operation.
- **Negative balances offset automatically** on the next earn, import or pending
  activation, in the same transaction.
- **Disabling the setting does not erase existing negative balances.**

---

## 4. One defect, in every domain

Every domain in this study had the same bug, with the same fix. It is worth
stating as a single rule because it will otherwise be rediscovered four times.

| Domain | The race |
| ------ | -------- |
| Coupons | Two orders both read `used < limit` |
| Wallets | Two debits both read sufficient balance |
| Referrals | One referee claims two referrers |
| Idempotency | Two requests both find no existing key |
| Per-customer caps | Two signups both count 2 existing accounts |

The naive pattern — read, check, write — is **always wrong across requests**,
because no isolation level covers a gap that spans two transactions.

**CVE-2026-31824** (Sylius, CVSS 8.2, CWE-362/367) is the clearest published
specimen. Eligibility read `used` from an in-memory ORM entity; the increment
happened later in a separate phase with *"no database-level locking or atomic
operations between the two phases."* The detail that makes it fatal: **Doctrine
flushed an absolute value (`SET used = 1`) rather than an atomic increment**, so
concurrent writers overwrote each other instead of accumulating. Exploitation
needs no authentication — prepare N carts with the same single-use coupon and
fire N simultaneous completion requests.

### 4.1 The fix, ranked

**1. Conditional single-statement mutation (best default).** Make the check and
the mutation one atomic statement:

```sql
UPDATE promotion
   SET used = used + 1
 WHERE id = :id
   AND (usage_limit IS NULL OR used < usage_limit);
-- 0 rows affected => exhausted. Treat as 409, not 500.
```

```sql
UPDATE accounts
   SET posted_debits = posted_debits + :amt
 WHERE id = :id
   AND (posted_credits - posted_debits - pending_debits) >= :amt
RETURNING id;
-- 0 rows => insufficient funds. Insert entries in the same transaction.
```

Correct at READ COMMITTED, one round trip, no explicit lock held. The cost is
row-lock contention on a hot row under flash-sale load.

**2. Unique constraint as the invariant.** `PRIMARY KEY (program_id,
referee_user_id)` makes one-referrer-per-referee structurally impossible rather
than merely checked. `UNIQUE (promotion_id, order_id)` on a redemption row makes
retries idempotent by construction. `UNIQUE (tenant_id, idempotency_key)` with a
request fingerprint handles replays.

**3. `SELECT ... FOR UPDATE`** on the row, then post. Correct and simple;
serialises per account, which is fine for user accounts and painful for system
accounts.

**4. `SERIALIZABLE` + retry on `40001`.** Postgres SSI costs under 7% versus
snapshot isolation and is the only level preventing write skew across multi-row
invariants. You must implement the retry loop; most teams forget.

**5. `CHECK` constraint as a backstop** on accounts that must not go negative.
Catches what application logic misses. Disable deliberately for accounts that are
*meant* to be overdraftable (system and escrow legs).

Avoid `REPEATABLE READ` for multi-row money invariants — it does not prevent
write skew without explicit locks.

### 4.2 The caveat that catches people

`SELECT ... FOR UPDATE` over *existing* rows locks only rows that already match.
Depending on isolation level it does **not** prevent a concurrent transaction
from *inserting* a new qualifying row. So a per-customer cap implemented as
"lock and count existing orders" still races.

**A per-customer cap wants a unique constraint or a counter row, not a locked
count.** This flaw is present in the published Sylius remediation and in
Fingerprint's reference anti-fraud tutorial, both of which count-then-insert.

### 4.3 Rate limiting is part of the same surface

**CVE-2026-55795** (Craft Commerce) is the companion lesson: the `RateLimiter`
was engaged **only when a client-supplied `number` parameter was present**, so
omitting it bypassed the limit entirely. The remediation applied the limit
unconditionally.

Two rules follow. **Apply rate limits unconditionally**, never gated on a
client-controlled parameter. And **key them on identity, not only IP** — shared
NAT makes IP-only limits both evadable and prone to false positives.

Also: **return a uniform error.** Distinguishing "no such code" from "code
expired" is an enumeration oracle.

---

## 5. The lifecycle is four operations, not one

Every mature system separates evaluation from commitment. Conflating them is
where double-spend lives.

```
preview (free) → reserve (consumes limits) → commit (settles) → rollback (bounded)
```

### 5.1 Preview — a genuinely non-mutating path

| System | Mechanism | Mutating? |
| ------ | --------- | --------- |
| Talon.One | `?dry=true` on session update | No |
| Capillary | `POST /v2/simulation/transactions` | No — "without performing any database writes" |
| Antavo | Points Preview API | No — "returns information about potential points earned" |
| Voucherify | Validate stackable discounts | No |
| Zinrelo | `get-potential-points` | No |
| Toast | `LOYALTY_INQUIRE` | No |

Talon.One's `now=` parameter is a good testability affordance: it accepts **only
future dates and only with `dry=true`**, giving scheduled-campaign rehearsal
without mocking the clock. Its matching warning is the kind of asymmetry that
bites — **idempotency is not supported for dry requests**, so wiring a preview
call into a retry loop behaves differently from the committing path.

### 5.2 Reserve then commit

**Four independent vendors converged on this**, because "is this still
available?" and "consume it" cannot be one atomic read in a distributed checkout.

| System | Phase 1 | Phase 2 | Rollback |
| ------ | ------- | ------- | -------- |
| Talon.One | session `open` + `reserveCoupon` effect | `closed` — budgets commit, coupons redeem, points settle | `cancelled` / `partially_returned` / reopen |
| Capillary | `Evaluate Promotions` with `isLockingEnabled` | `Redeem Cart Promotion` | `Cancel Cart Evaluation` |
| Antavo | `POST /v1/cart` — "temporarily reserves promotions with application limits" | `/cart/finalize` — "consuming limits where applicable" | — |
| Voucherify | `Validate stackable` (read-only) | `Redeem stackable` | `Rollback` — **not permitted beyond 3 months** |

Talon.One's session state machine is the most complete expression:
`open → closed | cancelled`, `closed → cancelled | partially_returned | open`,
`partially_returned → cancelled`. Closing is "the most important transition" —
it updates budgets and applies all effects.

**Two warnings the vendors publish about their own systems.** Capillary's cart
locking is **disabled by default and requires a support ticket to enable**, which
means most Capillary tenants run without the step where concurrency correctness
lives. And Antavo's docs describe `/cart` as stateless while also describing
reservation — an internal contradiction worth resolving before integrating.

### 5.3 Compensation is never total

Talon.One documents the exclusions, and they are the gotchas:

- **Attribute value updates are not rolled back**, in either `cancelled` or
  `partially_returned`. If a rule set `customer.lifetime_vip = true`, it stays
  true after the cancel.
- **Coupon creations are not rolled back** — the creation budget is not restored
  and the issued coupon remains redeemable. Only coupon *redemptions* roll back.
- Discounts roll back and restore the campaign budget.

Decide per effect type what is reversible, and write it down. A 2023 Talon.One
changelog entry records that reopening a session *now* fetches the most recent
close event to roll back against — implying it previously used a stale one.
Multi-close/reopen cycles are where reversal engines actually break.

### 5.4 Budget enforcement has three postures

| Posture | Example | Overshoot | Cost |
| ------- | ------- | --------- | ---- |
| Check at commit only | Medusa, Talon.One budgets | Yes, bounded by in-flight checkouts | Cheapest; good UX until the cap bites |
| Reserve at validate, commit at redeem | Voucherify `session: LOCK`, Talon.One `reserveCoupon` | No | Needs TTL, release, and a reaper for abandoned carts |
| Hard atomic check-and-increment at commit | Sylius post-patch | No | Contention on one hot row |

Talon.One documents the race rather than hiding it: *"a coupon added to an open
cart may stop being usable before checkout if other sessions close first."*
Medusa makes the opposite choice explicitly — *"a promotion already applied to a
cart stays valid until the order is completed, even if the limit is reached in
the meantime."*

For *monetary* budgets the reserve amount is not known until the cart is final,
so reservation is weaker than for *count* budgets. A workable compromise:
reserve a count at validate, enforce the monetary cap with an atomic conditional
decrement at commit, and size the cap with headroom equal to
`max in-flight × max per-order liability`.

---

## 6. Concurrency and idempotency contracts

### 6.1 Separate 409 from 429

Talon.One caps concurrent writes **per entity**: *"for each customer profile or
session integration ID, Talon.One allows up to three parallel requests. It
processes one immediately and queues up to two more."* Overflow returns
`409 Too many requests are updating this profile/session at the same time`.

Its error contract is a good template:

| Code | Meaning | Client action |
| ---- | ------- | ------------- |
| 400 / 401 / 404 | Client error | **Not retryable** |
| **409** | Concurrency conflict | **Retryable — switch to sequential for this key** |
| 429 | Rate limit | Retry with exponential backoff |
| 5xx | Server error | Retry with exponential backoff |

The distinction is load-bearing. **Backoff fixes overload and does nothing for a
burst of parallel read-modify-writes against one balance.** A global rate limit
cannot protect a single customer's balance. Most home-grown systems discover this
as a point-loss bug in production.

### 6.2 Differentiate retry semantics per operation

Toast maps each transaction type to its business consequence — the single most
transferable idea in the research:

| Transaction | On failure | Design intent |
| ----------- | ---------- | ------------- |
| `LOYALTY_REVERSE` | Retried with the **same** `Toast-Transaction-GUID` | Must succeed; safe to replay |
| `LOYALTY_ACCRUE` | Retried with a **different** GUID | Earning twice is tolerable; losing it is not |
| `LOYALTY_REDEEM` | **Not retried at all** | Double-spend unacceptable; fail closed |

Replay-safe, at-least-once, at-most-once — chosen per operation. **A single
global idempotency policy is wrong for at least one of the three.**

There is a trap buried in it. Toast also states that *"the Toast API does not
indicate that the request is a duplicate"* — your endpoint must return a cached
response itself. And because `ACCRUE` retries arrive with a *new* GUID,
**GUID-based deduplication cannot protect accruals**; that needs a business-level
key (check or order id). The docs name no alternative key.

### 6.3 Idempotency key design

- Client-supplied key scoped per tenant, under a **unique index** — uniqueness
  enforced by the database, not by check-then-insert.
- Store a **fingerprint hash of the canonicalised request body** alongside. Same
  key plus same fingerprint replays the stored response; same key plus
  *different* fingerprint returns `409` and never executes. Without the
  fingerprint, an accidentally reused key silently returns the wrong operation's
  result. Talon.One exposes this as `X-Idempotency-Fingerprint`, alongside
  `Idempotent-Replayed: true` and created/expires headers.
- **Store the response**, not just the key, so replays are byte-identical.
- Give keys an explicit TTL and document it — Talon.One's is 24 hours. A retry
  arriving after expiry will re-execute.
- Second layer: a unique constraint on the ledger transaction's natural business
  key. The idempotency table protects the API; this protects the ledger even if
  something bypasses the API.

**Natural keys beat supplied keys where one exists.** Antavo rejects a duplicate
`transaction_id` with `ERR_TX_ALREADY_EXISTS` and has no idempotency header at
all; Talon.One's advanced events return `409 An advanced event already exists`.
Supplied keys are for operations with no natural identity — an adjustment, a
manual credit. Capillary needing three *different* field names (`requestId`,
`uniqueId`, `external_reference_number`) across three endpoints shows what
retrofitting this looks like.

### 6.4 Transactional outbox

Never emit a webhook, notification or event from inside the money transaction,
and never after commit without durability. Write the event to an outbox table in
the same transaction and publish asynchronously, with consumer-side dedup.
At-least-once delivery is guaranteed; exactly-once is not.

Outbound delivery is at-least-once with coalescing in practice. Talon.One: 60s
response timeout, up to **10 resend attempts** or until `2xx`, retries on 5xx/429
and no-response, campaign notifications taking **up to five minutes** with
repeated changes collapsed to the latest state, payloads batched with
`currentBatch`/`totalBatches`.

Shopify is blunt about the limits of webhooks: *"Webhook delivery isn't always
guaranteed"*, no ordering guarantee "within a topic, or across different topics
for the same resource" — a `products/update` can arrive before its
`products/create`. Dedup on `X-Shopify-Webhook-Id`, order by
`X-Shopify-Triggered-At`. Their recommended mitigation is **reconciliation jobs
that periodically re-fetch**. Treat a webhook as a cache-invalidation hint, not
as the source of truth.

Both Talon.One and Antavo instruct consumers to **ignore unknown response
properties** — forward compatibility by contract rather than versioning. State
it before you need it.

---

## 7. Per-domain findings

### 7.1 Loyalty — the schema

```sql
-- Projection, written in the same transaction as the entry
loyalty_account(
  tenant_id, account_id PK, member_id, program_id,
  currency_code,                       -- qualifying vs spendable are different rows
  subledger_id,                        -- NULL = main wallet
  active_balance BIGINT NOT NULL,      -- materialised
  pending_balance BIGINT NOT NULL,
  lifetime_earned BIGINT NOT NULL,     -- never decremented
  version BIGINT NOT NULL,
  UNIQUE(tenant_id, member_id, program_id, currency_code, subledger_id)
)

-- System of record
loyalty_entry(
  tenant_id, entry_id PK, account_id FK,
  entry_type ENUM('EARN','BURN','EXPIRE','REVERSAL','ADJUST',
                  'TRANSFER_IN','TRANSFER_OUT','NEGATIVE_ACCRUAL'),
  amount BIGINT NOT NULL,              -- SIGNED integer minor units, never float
  source_type, source_id,
  idempotency_key TEXT NOT NULL,       -- UNIQUE(tenant_id, idempotency_key)
  reverses_entry_id FK SELF NULL,      -- partial-unique: one reversal per entry
  rule_id, rule_version,               -- provenance
  occurred_at_utc TIMESTAMPTZ NOT NULL, -- business time
  recorded_at_utc TIMESTAMPTZ NOT NULL  -- system time
)

-- Only if expiry or FIFO exists
loyalty_lot(
  tenant_id, lot_id PK, account_id FK, origin_entry_id FK,
  original_amount BIGINT, remaining_amount BIGINT,
  activates_at, expires_at NULL,
  issuance_contract_id FK NULL,        -- coalition: which contract issued it
  state ENUM('PENDING','ACTIVE','EXHAUSTED','EXPIRED','REVERSED')
)

-- Which burn ate which lot
loyalty_consumption(
  tenant_id, consuming_entry_id FK, lot_id FK, amount BIGINT,
  PRIMARY KEY(tenant_id, consuming_entry_id, lot_id)
)
```

A note on the idempotency key: a real-world one is
`store + register + business_date + transaction_number` — reproducible by the POS
on retry. **A UUID the client generates fresh on each retry is worthless.**

### 7.2 Loyalty — expiry calendar arithmetic

This is where correct-looking code is wrong. Voucherify documents the rules, and
they are representative:

- **Anchor is the activity date** (order date), not the posting date.
- **Month-end rounds down.** Points earned 31 Jan with a 1-month period expire at
  the end of **28 Feb**. Naive date math throws or lands in March, and you get
  off-by-one-month liability errors every February.
- **Round-up buckets** — expiry can round to end of month/quarter/half/year.
  This collapses N lots into a handful of dates and makes the nightly expiry job
  cheap. Eagle Eye exposes the same declaratively:
  `{ "periodCount": 6, "periodType": "MONTH", "rounding": "MONTHEND", "type": "CUTOFFDATE" }`.
- **Pending points: expiration starts at activation, not at earning.** So
  `expires_at` cannot be computed at insert time for a pending lot — it must be
  written when the lot activates.
- **Transfers get a new expiration** starting on the transfer day. A transfer is
  burn-then-earn, not a lot move. Expired and pending points cannot be
  transferred.

**Activity-based expiry breaks the lot model.** The variant where any qualifying
activity resets the clock on all outstanding points — common in airline programs
— makes `expires_at` a function of *future* events. It cannot be a stored column;
it is either `max(last_activity_at) + TTL` evaluated at read/job time, or a mass
UPDATE across every open lot on each activity. The second is unbounded write
amplification on your most frequent buyers.

**Expiry must be an entry, never a delete.** A TTL that silently removes balance
destroys the audit trail the breakage estimate depends on — a
financial-statement problem, not just an engineering one.

### 7.3 Loyalty — tiers, and two ordering rules

Three canonical qualification models, named consistently (Oracle Siebel):
**Anniversary Date**, **Fixed Date**, **Rolling Period**. Rolling is
architecturally distinct — *"the member's point balance is never reset to zero in
this model"* — and even Oracle does not compute it inline; a separate API
extracts running balances from accrual items as a precomputed aggregate.

Tier state is **materialised, not derived**. No shipped system computes tier on
read.

Two ordering rules must be right:

1. **Points expire before tiers are re-evaluated.** Talon.One: when both expire
   at the same time, *"points expire first, so tier reevaluation uses the updated
   balance."* Reverse this and you retain members on points that no longer exist.
2. **Only active points count toward tier**, and negative points do not affect
   tier. This deliberate decoupling stops a refund-induced negative balance from
   cascading into a demotion.

Voucherify documents an emergent bug caused purely by batch step order: its
nightly job runs activate → **auto-redeem** → tier recalculation → expire →
balance-based tier recalculation, and *auto-redeem running before tier checks can
prevent a customer from reaching a balance-based tier.*

**A boundary bug shipped in reference documentation.** Oracle's own worked
example uses strict inequalities — upgrade on `balance > 150000`, downgrade on
`balance < 150000` — so a balance of *exactly* 150,000 matches no rule and the
member silently falls through evaluation.

**Retroactive tier processing is usually impossible.** Siebel does not support it
on any model introduced since 8.1. Voucherify will upgrade but never downgrade
retroactively, and removed tiers are lost immediately. **Plan for "we cannot
replay tier history" as the default** and make correction a forward-dated manual
grant.

### 7.4 Promotions — three orthogonal axes

Mature engines separate **value** (what the money does), **target** (what it
attaches to) and **allocation** (how one amount splits across lines). Immature
ones conflate value and target and then cannot express BOGO at all.

**BXGY is a selection problem, not a value problem.** The real variable is which
units get discounted: commercetools `SelectionMode` (cheapest or most expensive,
split into `maxOccurrence` groups); Voucherify `APPLY_TO_CHEAPEST` /
`APPLY_FROM_CHEAPEST` / `APPLY_TO_MOST_EXPENSIVE` / `APPLY_TO_EVERY` with
`repeat`/`skip_initially` for "every 3rd item"; Talon.One addressing units by
`position` + `subPosition`.

**Keep intent and realisation separate.** Shopify's modelling statement is the
one to copy: *"Discount applications don't represent the actual final amount
discounted on a line."* The `DiscountApplication` is the intent, the
`DiscountAllocation` is the realised per-line money. Store both.

Allocation modes for an absolute discount, with commercetools' worked example of
$15 off a $56 cart:

| Mode | Behaviour |
| ---- | --------- |
| `ProportionateDistribution` (default) | line / cart total × discount — a $16 line gets ≈ $4.28 |
| `EvenDistribution` | $15 / 3 lines = $5.00 each |
| `IndividualApplication` | the **full $15 off each eligible line**, floored at zero |

### 7.5 Promotions — order is non-commutative

commercetools' own example: a $100 cart with a 10% discount and a $5 discount.
Percentage first gives **$85**; fixed first gives **$85.50**. Fifty cents swings
on a sort key.

Two consequences:

- **Order survivors by a deterministic key, not by value** —
  `(class, exclusivity, priority, type, id)` with a stable tiebreaker. The same
  cart must price identically on retry, on the order page, and at refund time.
- **Push order-level discounts down to lines before tax**, because tax rates
  differ per line. Saleor documents this step explicitly and it is the one people
  skip. Its stated invariants are worth copying: `line.totalPrice` is the source
  of truth, `unitPrice = totalPrice / quantity` (so `unitPrice × quantity` may
  differ from `totalPrice` by rounding), and `order.total = Σ line.totalPrice`.

**Who funds the discount changes the tax base.** In most US states an
unreimbursed *store* coupon reduces the taxable base; a reimbursed *manufacturer*
coupon does not, because the retailer receives third-party consideration. Texas
is an exception and treats both as cash discounts. **This is a data-model
requirement:** the promotion entity needs a `funding_source` / `reimbursed_by`
field, and the tax call needs it per line.

**Rounding.** Allocate in integer minor units with the **largest-remainder
method** — floor each share, hand leftover units to the largest fractional
remainders — so allocations sum exactly to the total. Centralise it in a single
`allocate(total, weights)` function and property-test that `sum(parts) == total`.
**Persist the per-line allocated amount at checkout and refund from the stored
values**; re-apportioning at refund time lets partial refunds drift by a cent.

### 7.6 Promotions — "best deal" is not a global optimiser

**No documented engine does global combinatorial optimisation.** Every verified
best-deal is an argmax over a small, explicitly-declared bucket:

- commercetools DiscountGroup — argmax over ≤100 discounts in one group
- commercetools BestDeal — argmax over exactly **two** candidates (product-discount
  total vs cart-discount total)
- Talon.One "Highest discount value" — argmax over campaigns in one evaluation group
- Elastic Path — argmax within each of four fixed buckets
- Shopify `MAXIMUM` — a local argmax inside one function's candidate list

Marketing language implying otherwise is not backed by any documentation found.
The hardness evidence is real but indirect: a USPTO retail patent describes the
problem, identifies dollar-off-dollar coupons as the hardest case because *"the
number of possible combinations grows very fast"*, and then uses a heuristic. A
later application in the family calls exact solutions *"unrealistic and
impractical."* **Formal NP-hardness for retail stacking is not proven in any
source found** — treat it as well-supported intuition, not theorem.

Two design decisions keep it tractable. **Fix the order by policy**, collapsing
permutations to subsets. **Fix the base** — Shopify computes two percentage order
discounts on the same subtotal, so 10% + 20% is $30 off $100, not $28, making
composition additive and order-independent. With both, the eligible set at
checkout is capped at 5–30 anyway (Voucherify 30 redeemables, Shopify 5 codes +
1 shipping), so a bounded search is affordable.

### 7.7 Codes

| Kind | Storage | Validation |
| ---- | ------- | ---------- |
| Single shared (`SUMMER20`) | One row | Counter + per-customer cap |
| Bulk pre-generated unique | N rows, unique index on normalised code | Row lookup + per-code limit |
| Dynamic / signed | Generated at send time, or not stored at all | Row lookup, or HMAC verify |

**Normalisation is permanent.** Voucherify fixes case sensitivity when the
project is created and it cannot be changed afterwards. That is the right call —
your normalisation function (trim, case-fold, strip separators) defines the
unique index, so it can never change once codes are live.

**Entropy.** A 63-character charset at length 8 gives ≈2.48 × 10^14 codes;
issuing 10^9 leaves ≈4-in-a-million odds that a random guess hits one. Rule of
thumb: keep `issued / space ≤ 10^-6` **and** rate-limit. Entropy alone is not a
control.

**Never let users choose their own code.** In 2014 an Uber user replaced his
random referral code with a memorable, searchable one, seeded it on Reddit and by
email, and collected **over $50,000** in ride credits from strangers. Codes must
be unguessable and un-SEO-able, and never derivable from usernames.

**Signed codes remove the issuance table, never the redemption table.** A signed
token gives no one-time-use or anti-replay guarantee and cannot be revoked. Use
them for multi-use expiring offers; single-use still needs a redemption record,
at which point the write is back.

Partition code tables by campaign so expiring a campaign is a partition drop
rather than a mass DELETE, and bulk-generate offline — never inside the serving
transaction. Let the unique index reject collisions rather than pre-checking.

### 7.8 Referrals — attribution

The structural point: **the cookie is a touch, the attribution is a row.**
Cookies cover only the pre-registration window; a server-side relationship row
covers everything afterwards, forever, across devices.

```sql
referral_code(
  tenant_id, program_id, id, owner_user_id, code_normalized, status,
  UNIQUE (program_id, code_normalized),     -- case-folded
  UNIQUE (program_id, owner_user_id)
)

referral_attribution(
  tenant_id, program_id, referee_user_id, referrer_user_id, code_id,
  method, confidence, touch_id, attributed_at,
  PRIMARY KEY (program_id, referee_user_id),   -- ONE referrer, ever, write-once
  CHECK (referrer_user_id <> referee_user_id)  -- cheapest self-referral block
)

reward(
  tenant_id, program_id, id, beneficiary_user_id, side, attribution_key,
  state, amount_minor, currency, hold_until, qualified_at, approved_at,
  paid_at, reason_code,
  UNIQUE (program_id, beneficiary_user_id, side, attribution_key)
)

processed_event(tenant_id, provider, event_id PRIMARY KEY, handled_at)
```

Four invariants carry the weight:

1. **Write-once PK on the referee** — no UPDATE path in the repository. Gives
   exactly-once reward issuance and kills re-attribution abuse.
2. **`CHECK (referrer <> referee)`** at the DB level, not in a service.
3. **Attribution resolved inside the account-creation transaction**, server-side,
   from a code the server re-resolves itself. Never a separate
   `POST /claim-referral` the client can call — that is a forgeable endpoint and
   the most common hole. If a deferred deep link forces one, make it
   authenticated, single-use and bounded to a short window after
   `user.created_at`.
4. **Append-only ledger** — clawbacks are reversing entries, never deletes.

**Attribution carriers.** Code (survives every channel, signals intent, typo-prone),
link (zero friction, but params get stripped and cookies capped — Safari ITP caps
first-party analytics cookies at 7 days), deep link (the only way to attribute a
mobile install). The design everyone converges on is **hybrid**: the link
pre-fills the code, and the code is the fallback the user can always type.

**Android install attribution is deterministic.** The Play Install Referrer
Library returns `installReferrer`, `referrerClickTimestampSeconds`,
`installBeginTimestampSeconds`, `googlePlayInstantParam`; data is available for
90 days and does not change unless the app is reinstalled. **Google's doc
describes no integrity, signing or spoofing protection** — treat `installReferrer`
as untrusted input and sanity-check the click-to-install delta. A near-zero or
negative delta is a forgery signal.

**iOS has no equivalent.** Clipboard tokens, probabilistic fingerprinting
(degrading on VPN and iCloud Private Relay), SKAdNetwork (aggregated, no
user-level match, therefore useless for crediting a specific advocate), or manual
code entry. GrowSurf's own docs call iOS deferred attribution "best-effort" and
recommend manual code entry as the fallback.

**Store `method` and `confidence` on every attribution row** (deterministic for
code entry and Play referrer, probabilistic for fingerprint match) and **run
different fraud thresholds and hold periods per confidence class.**

**Windows.** Typical practice is 30 days for a link click and no expiry for a
typed code, on the reasoning that typing a code is explicit intent. Precedence
worth copying: **code entry overrides everything; absent a code, last-click
wins** — documented in both the referral and affiliate terms. Referral is not ad
attribution: the reward is discrete and non-divisible, so fractional multi-touch
credit is the wrong model. What you need is a *channel de-duplication* rule for
when a paid-affiliate click and a referral code both touch one order. Paying both
is how programs leak margin.

### 7.9 Referrals — the reward state machine

| From | To | Trigger |
| ---- | -- | ------- |
| — | `PENDING` | Attribution row created; nothing is reserved |
| `PENDING` | `QUALIFIED` | Qualifying event — first settled payment, min spend, onboarding complete |
| `PENDING` | `EXPIRED` | Qualification window elapses — bounded liability |
| `QUALIFIED` | `ON_HOLD` | Risk score / cluster hit / velocity breach |
| `QUALIFIED` | `APPROVED` | `hold_until` passes with no reversal (daily batch) |
| `APPROVED` | `PAID` | Payout run; idempotent on the attribution key |
| any pre-payout | `REVERSED` | Refund, dispute, cancellation inside hold — costs nothing |
| `PAID` | `CLAWED_BACK` → debt | Reversal after payout; net against the **next** payout |

**Sign-up is not earned.** And the hold period must cover three things: your
refund window, card chargeback windows (considerably longer), and **your fraud
investigation latency**. Graph detection jobs are batch; a hold shorter than your
detection cycle means you pay before you can detect. Published holds run 30–90
days.

Partial refund: shrink the amount proportionally and leave the state alone.
Recurring: each invoice gets its own reward row and its own hold clock.

**Double-sided is not two rows instead of one.** It changes five things: the two
sides qualify at different times and reverse independently; the referee-side
reward is **pre-paid risk** (a discount spent before the qualifying event
settles); self-referral becomes strictly more profitable because the fraudster
collects both legs; the referee reward is a discount code and therefore the
leakage vector; and budget math becomes per-pair, with the kill switch needing to
stop both legs atomically.

**On the evidence for double-sided:** the vendor consensus ("two-sided always
wins, +30–50%") has **no underlying study behind it** that the research could
find. The academic picture is conditional — JAMS 2022 finds one-sided *referee*
rewards work better for consumers high in interdependent self-construal, because
a referee-side reward defuses the social cost of appearing mercenary. The
well-supported finding is the foundational one: referred customers are worth **at
least 16% more**, with higher contribution margin (which erodes) and higher
retention (which persists), across ~10,000 customers tracked for nearly three
years.

---

## 8. The effects pattern — and what it is really about

**Definition:** the rules engine returns a declarative list of what *should*
happen; the caller applies it. The engine never reaches into the cart.

Talon.One is the canonical implementation. A session update returns:

```json
{ "effects": [ {
    "campaignId": 3882, "rulesetId": 14828, "ruleIndex": 0,
    "ruleName": "Check XMAS coupon", "effectType": "setDiscount",
    "triggeredByCoupon": 4607465,
    "props": { "name": "10% off with XMAS coupon", "value": 20.0 }
  } ], "ruleFailureReasons": [] }
```

Roughly 45 effect types across seven families — discounts, loyalty, coupons,
referrals, rewards/giveaways, achievements, and escape hatches (`customEffect`,
`triggerWebhook`, `showNotification`, `set`).

Three structural observations:

1. **Every effect carries full provenance** (`campaignId`, `rulesetId`,
   `ruleIndex`, `ruleName`), so the integration can explain *why* a discount
   appeared. Failure effects add `conditionIndex`.
2. **Nearly every mutating effect has a `rollback*` twin.** The vocabulary is
   designed for compensation because returns and cancellations are normal, not
   exceptional.
3. **`customEffect` with an arbitrary payload is the extension point** — tenants
   define effects the platform knows nothing about and the integration
   interprets them. That is how you avoid shipping a platform release for every
   new reward type.

The docs warn: **do not rely on the order of items in the effects array.**

### 8.1 The reason is ownership, not network boundaries

The stated rationale is division of ownership: *"you are responsible for applying
the discount in your webshop."* The engine does not own pricing, tax, inventory
or payment, so it cannot safely mutate them — and it cannot un-charge a card,
which is why rollback effects exist.

**Shopify independently arrives at the same shape from the opposite direction.**
A Shopify Function runs *in-process* as WebAssembly inside Shopify's own
checkout — no network call, no separate owner — and **still returns declarative
operations rather than mutating the cart**. The tell is `selectionStrategy`
(`FIRST | MAXIMUM | ALL`): the function submits *candidates* and the platform
picks. Shopify is explicit that "functions run concurrently and don't know about
each other."

So the effects pattern is not about network boundaries. It is about **who is
allowed to resolve conflicts between independently-authored rules.**

**The genuine counter-examples are defensible.** commercetools evaluates
`cartPredicate` and mutates the cart itself — viable precisely because
commercetools *is* the system of record for the cart. Salesforce returns no
effects at all: you post a `TransactionJournal`, a program process matches on
type/subtype and writes `LoyaltyLedger` rows. Input is an event, output is state.
That works because Salesforce also owns the ledger, and it is why Salesforce
needs batch jobs where Talon.One needs none.

**Lightspeed X-Series inverts it entirely** — the caller computes the effect and
writes it in, POSTing `loyalty_value` onto each sale line.

**The dividing line is ownership of the cart, not preference.** Cross-boundary
means effects; same-system means mutation.

---

## 9. Events, and the backfill trap

### 9.1 Event schemas are registered, not free-form

Voucherify requires an event name to be pre-defined in Project Settings → Event
Schema before a rule can reference it. Talon.One requires creating the event in
the Campaign Manager first. Capillary rejects unregistered names with a specific
status code and separately validates payload schema.

This is deliberate: **a registered schema is what lets a non-engineer build a
rule against the event in a UI.** If you want business users authoring rules, the
event catalogue has to be a first-class, versioned artifact.

Antavo publishes ~60 externally-submittable events and ~60 internal ones —
`checkout`, `checkout_item`, `refund`, `partial_refund`, `point_add`/`point_sub`/
`point_spend`, `coupon_redeem`/`coupon_unredeem`, `referral`, `referral_bonus`,
`review_submit`, `visit`, `daily_login`, `reserve_points`/`release_points`.

### 9.2 Events are immutable; corrections are compensating events

Antavo states the discipline most clearly: *"Events are immutable — once created,
they cannot be removed, altered, or reassigned to different customers, nor can
their date be changed retrospectively. Therefore, Antavo does not provide any API
methods or other interfaces to remove events."* Corrections are
`checkout_update`, `checkout_reject`, `point_sub`, `refund`, `coupon_unredeem`,
`reward_revoke`. Processing is FIFO without reordering.

Open Loyalty is the open-source proof that this is deliberate architecture —
Symfony + Doctrine + **Broadway** (CQRS/event sourcing), with a refreshingly
honest caveat: ***"No[t] everything in Open Loyalty is event sourced. And that's
fine."*** Selective event sourcing — the points aggregate, not the campaign
config — is the pragmatic position.

Its three-tier vocabulary is worth copying:

- **Commands** — "a user intention… **may be rejected**" (`AddPoints`,
  `SpendPoints`, `ExpirePointsTransfer`)
- **Events** — "have happened… **cannot be rejected**" (`PointsWereAdded`,
  `PointsWereSpent`, `PointsTransferHasBeenExpired`)
- **System events** — "thrown during executing a command… may be used to trigger
  another commands" (`AvailablePointsAmountChangedSystemEvent`,
  `CustomerLevelChangedSystemEvent`, `CustomerAddedToSegmentSystemEvent`)

**That third category is what home-grown systems usually lack, and its absence is
what produces god-methods in the service layer.**

### 9.3 Backfill must bypass the rules engine — and the trap

Voucherify's bulk order import *"does not trigger distributions or earning
rules"*, creates no events, and fires no webhooks. **But**: if imports include
customers, Voucherify schedules segment re-evaluation, which *"can trigger
customers entering into segments, along with earning rules based on the customer
entering segment(s)."*

**So a backfill is inert on the path you expect and live on the one you don't.**
Imported orders also get `created_at` set at import time — preserving the real
date requires stashing it in metadata.

Talon.One's model is two-track: historical orders replay as **closed sessions**
through the normal endpoint, while historical points bypass the engine entirely
via CSV with explicit dates. Its time-travel parameter is restricted to **future
dates and only with `dry=true`** — you cannot replay the engine as-of a past
date.

**Document your backfill semantics in writing before you run one.** This is the
kind of thing that becomes a production incident precisely because it is
undocumented.

---

## 10. Real-time versus batch

The split is remarkably consistent across every system.

**Must be synchronous** — discount calculation at checkout, coupon validation,
balance inquiry, redemption authorisation. These block a human at a terminal.

**Must be asynchronous** — point expiry (nothing triggers it but the clock), tier
recalculation, pending→active activation, segment rebuilds, and in several
systems accrual itself. Toast: *"Accruing rewards happens asynchronously"* and
occurs after payment, while redemption is synchronous.

The cleanest proof is Antavo's split: anything you can *push* is synchronous;
anything the *engine decides* emerges later as an internal event you cannot
trigger. All tier movement is internal — `tier_up`, `tier_down`, `tier_change`,
`tier_evaluation_date_moved`, `points_expired`.

**Salesforce documents the cost of choosing the fast path**, and this is the best
cautionary example in the research. Its batch path creates a `TransactionJournal`
with `Status = Pending` for a scheduled job to process. Its real-time Connect
resource processes inline — but **promotion limits configured on a
`PromotionLimit` record "aren't automatically enforced"** when journals are
created that way. You must call *Eligible Promotions List* first and pass the
results in an `appliedPromotions` array.

**The synchronous path buys latency by giving up a global invariant and pushing
responsibility for it onto the caller.** Talon.One hits the same wall and
resolves it differently — budgets are checked on every update but commit only at
session close, i.e. reserved optimistically.

**Pending value needs its own state everywhere.** Every system has a word for
"earned but not spendable": Talon.One `pendingPoints` + `awaitsActivation`,
Voucherify pending points, Square `expiring_point_deadlines`, Capillary
`promised` points, Zinrelo `pending_points` separate from `available_points`,
Antavo `pending_validate`/`pending_invalidate`.

**Segments.** Voucherify's passive/active distinction is a neat solution to a
real problem: passive segments are filter-based and update in real time but
**emit no events**, and Voucherify *"automatically converts a passive segment
into an active segment if it is used in loyalty earning rules, distributions, or
referral tiers."* Only pay for event emission where something consumes it.

---

## 11. Multi-tenancy

Three postures, and they are not interchangeable:

| System | Model | Mechanism |
| ------ | ----- | --------- |
| Talon.One | **Silo** | "Each customer instance is stored in its own VPC"; Kubernetes across two GCP AZs; 8 selectable regions |
| Antavo | **Bridge** | 1,500 rpm shared stack vs 20,000 rpm dedicated — tenancy tier *is* the deployment tier |
| Capillary | **Pool + regional silo** | Four regional clusters, shared within region |
| Voucherify | **Pool** | Project-scoped, limits by plan |
| Shopify | **Pool + per-execution sandbox** | A WASM isolate per function run; caches isolated per store |

### 11.1 The isolation asymmetry worth flagging

In Talon.One, campaigns and customer activity are Application-scoped — *"You
cannot share customer activity or campaigns across different Applications."*
**But the customer profile is not.** The OpenAPI spec states a profile "can be
linked to simultaneous sessions in **different Applications**", and profiles
"can only be accessed by Applications from the same **environment**."

**So the shared object spans the isolation boundary that every scoped object
respects.** A test that asks only "can Application A read Application B's
campaign?" passes while A and B are both mutating one profile.

This is the same shape as the blind spot already recorded in our own notes: *A
using its own row to reach a shared global object.* In an engagement system the
shared objects are the identity graph and the incentive ledger, and a cross-tenant
leak there is worse than in an ordinary table.

### 11.2 Noisy-neighbour controls — four distinct techniques

**(a) Per-key throughput quotas.** Voucherify publishes 100/min (Business) and
2,000/min (Organization), plus 100k/300k per cycle, client-side 5 requests per 5
seconds per IP, and a sandbox fixed at 100/hour that cannot be raised.
Lightspeed X-Series scales quota with physical store size — `300 × registers +
50` per 5-minute window — and returns `Retry-After` as an **HTTP-date, not
delta-seconds**.

**Typed rate-limit headers are worth stealing.** Voucherify returns
`X-Rate-Limit-Type` ∈ `{api_calls, bulk_api_calls, api_calls_cycle,
webhook_calls}` alongside limit/remaining/retry, so a client that knows *which*
budget it blew can back off selectively rather than globally.

**(b) Per-entity concurrency caps** — §6.1. The control nobody else documents,
and the one that actually protects a balance.

**(c) Bounding the work per request.** Talon.One `evaluableCampaignIds` lets the
caller restrict which campaigns run; `responseContent[]` means you pay only for
what you read; `silent=yes` returns `204` instead of a full profile. Capillary
labels hot-path endpoints "This is a light API."

**(d) Hard configuration ceilings** — the real noisy-neighbour control in a
shared rules engine. Voucherify per program: **10 wallets, 100 rewards, 100
earning rules, 1 tier structure, 100,000 members**, static segments capped at
20,000, and **30 redeemables per validate or redeem**. Shopify: 25 discount
functions per store. commercetools: 100 active cart discounts. Talon.One:
sub-ledger enablement fixed at program creation.

**Bound the configuration surface, not just the request rate.**

### 11.3 Observability headers worth copying

Capillary returns `X-Cap-Requestid` (end-to-end trace spanning a whole batch) and
`x-cap-api-request-uri` carrying the **URI pattern rather than the raw URI** —
"enabling cleaner metrics." Cheap to implement, and it keeps identifiers out of
metric cardinality and logs.

Toast's rule is a good precedent for the same concern: `loyaltyIdentifier`
*"must not contain personal information such as email addresses or phone
numbers"* — a UUID is suggested.

---

## 12. Integration surface and the latency budget

### 12.1 The directionality thesis

**Only two platforms in the entire study publish a latency budget, and they are
exactly the two that make outbound calls during checkout.** Everyone you call
*into* publishes throughput quotas instead. **The direction of the call
determines the kind of contract you owe.**

**Toast → loyalty provider**, verbatim from the spec:

> "The response time for a loyalty transaction request must be less than **500ms
> on average**. A response time of greater than **5000ms** will be considered a
> timeout and will be retried. There is a limit on the number of retries which
> depends on the context of the call."

Past the maximum, Toast "may close the socket and send another request", and
**the guest sees an error at the till telling them to contact *your* support.**
No percentiles published. No offline support: the POS queues accruals but blocks
redemptions entirely.

**Shopify Functions → external service:**

- `readTimeoutMs` constrained to **100–2000 ms** (examples use 500)
- Success cached up to **300 s**; connection errors, 5xx and 429 cached up to
  **30 s**; cache key is method+URL+headers+body; **caches isolated per store**;
  `Cache-Control` headers **ignored**
- Persistent connection errors trip a **per-host-and-port circuit breaker
  lasting over 20 s**
- Timeout surfaces as `504` to the function, connection/SSL failure as `502`; the
  function returns a local fallback, and "if it throws instead, the platform's
  default fallback applies"

**Shopify's position is the sharpest architectural statement in the research.**
Network access is enterprise-gated and the docs actively steer you away from it —
pre-stage data into **metafields** instead, because that "avoids an external call,
and Shopify handles their uptime, scalability, and durability." **Shopify's
answer to the checkout latency budget is to not have a network call in it:** ship
the rule to the data as WASM, pre-stage the data. Where a call is unavoidable,
the timeout ceiling, cache and circuit breaker are enforced *by the platform*,
not left to the integrator.

**The negative case is equally informative.** Lightspeed publishes no callout
contract and no latency budget on any product line, and K-Series has **no loyalty
endpoints at all**. The practical consequence, confirmed by a live loyalty
vendor's integration guide, is post-hoc order polling matched by email — which is
categorically different from an integration.

**Practical guidance: target sub-500 ms p99 on the checkout path, assume a hard
kill at 2–5 s, and decide fail-open versus fail-closed per operation.** Toast has
already made that call for you by refusing to retry `LOYALTY_REDEEM`.

### 12.2 Shopify Functions — the in-process alternative

| Resource | Limit |
| -------- | ----- |
| Execution budget | **11 million WASM instructions** (CPU proxy; no wall-clock) |
| Linear memory / stack | 10,000 kB / 512 kB |
| Compiled binary | 256 kB |
| Input size | 128 kB *(see §18 — two official pages disagree)* |
| Output size | 20 kB |
| Input query | 3,000 bytes, max calculated cost 30 |
| Active discount functions per store | 25 |

CPU is metered in **instructions, not wall-clock** — deliberately, since
instruction count is deterministic and therefore fair and locally testable.
Replacing a network hop with an instruction budget removes tail latency entirely
but caps expressiveness: 20 kB of output "doesn't support bulk price
transformations across all line items."

### 12.3 The engine's data copy is a cache, not a record

Voucherify customers "don't need to exist before a validation or redemption" and
are upserted from request data; products need not be stored at all, and "even
when a product is stored, the payload data is used instead." Talon.One
auto-creates an empty profile if one does not exist.

**That is what lets these engines stay on the checkout path** — they never block
on a prior synchronisation.

---

## 13. Wallets — holds, money, and reconciliation

### 13.1 Holds are a two-phase transfer, not a flag

TigerBeetle's two-phase transfers are the cleanest reference:

- **Phase 1 (authorise)** — a `pending` transfer raises `debits_pending` on the
  payer and `credits_pending` on the payee. Posted balances untouched.
- **Phase 2 (resolve)** — a *separate* transfer referencing `pending_id`, flagged
  post or void. Post may settle **less** than reserved (partial capture); void
  releases entirely.
- **Expiry** — a `timeout` (an interval, not an absolute timestamp) auto-voids.
  Release may occur some time *after* the deadline by design; never write capture
  logic that assumes exact-moment release.
- **Single resolution** — a pending transfer can be posted or voided exactly
  once. **You get idempotency for free from this property.**

The reservation guarantees phase 2 can never break balance invariants, whichever
way it resolves.

### 13.2 Balance definitions — the #1 production bug class

```
posted    = Σ posted credits − Σ posted debits
available = posted − Σ pending DEBITS          ← note the asymmetry
pending   = a view, not a spendable number
```

**Pending *credits* must not count toward available.** Incoming money that has
not settled is not spendable. Expose `available` to the spend path and `posted`
to statements, and never let one code path read one and decide on the other.
"Balance conflation" is named as the single most common production bug class at
fintechs.

A reaper job is required even with DB-level timeouts, because external
authorisers have their own expiry semantics. Make it idempotent and make
"void an already-voided hold" a no-op, not an error.

### 13.3 Money representation

- **Integer minor units plus a currency code, always travelling together.** Never
  a float. `int64` gives ~9.2 × 10^18 minor units.
- **Derive the scale from the ISO 4217 exponent — never hardcode ×100.**
  Exponent 0: JPY, KRW, VND, CLP. Exponent 3: BHD, JOD, KWD, OMR, TND.
  Exponent 4: CLF, UYW. A hardcoded 100 is wrong for a meaningful slice of the
  world.
- **Converting major→minor: round, don't truncate.** `1.999 × 1000` is
  `1998.9999999999998` in IEEE-754; truncation undercharges.
- **Reject over-precise inputs** rather than silently truncating.
- **One account per (owner, currency).** Never a single balance netting across
  currencies. An FX conversion is two postings plus an FX gain/loss posting, with
  the rate and the rate's own scale stored on the transaction.
- **At API boundaries, model money as `{amount: "1000", currency: "USD"}`** — a
  string or integer, never a JSON `number`. JS loses precision above 2^53 and
  JSON parsers vary.

### 13.4 Reconciliation

**Three-way: internal ledger ↔ PSP settlement report ↔ bank statement.** Two-way
only proves the PSP agrees with you; it does not prove the money arrived.

Make the PSP a **real asset account**, not a status field:

```
Capture:     DR PSP in-transit        / CR customer wallet
Settlement:  DR bank, DR PSP fee      / CR PSP in-transit
```

If the in-transit account does not drain to approximately zero on the expected
cadence, you have a break — **visible as a balance, not as a report you have to
remember to run.**

Classify every exception into a named queue with an owner: timing, amount
mismatch (overwhelmingly **PSP fees netted inside the settlement amount**), FX
variance, missing bank credit, missing PSP record, duplicate. Normalise per PSP
*before* matching — PSPs change file formats without much notice, and schema
drift produces a flood of false exceptions that destroys trust in the process
faster than any real break.

Unmatched items post to **Suspense (9000)** rather than being forced onto a
guess, and suspense must be zero at period close. Run reconciliation
continuously; the useful alert is "suspense balance > X for > N hours", not
"month-end didn't tie".

---

## 14. The regulatory boundary

**Not legal advice.** Thresholds move, India's framework is mid-rewrite, and US
rules are state-by-state. Verify against primary sources before relying on any
number here. The architectural consequences, however, are stable — and they are
the reason this section exists in an engineering document.

### 14.1 India — RBI Prepaid Payment Instruments

Statutory basis: Payment and Settlement Systems Act 2007, s.4 — operating a
payment system without RBI authorisation is an offence. Operative instrument is
the **Master Directions on PPIs (27 August 2021)**, as amended.

**A balance sits outside the PPI framework — needing no authorisation — only if
all four hold:**

1. Redeemable **only** against goods and services supplied by the issuing legal
   entity itself
2. Cannot be withdrawn as cash
3. Cannot be transferred to a bank account or to another user
4. Never settles an obligation owed to anyone other than the issuer

Break any one and you need a Certificate of Authorisation. RBI's own FAQ confirms
closed-system PPIs are *"not classified as a payment system requiring approval /
authorisation by the RBI"* and *"not regulated or supervised by RBI."*

**The practical traps:**

- **Group companies are separate legal entities.** Credit usable across OpCo A
  and OpCo B is not closed-loop, same brand or not.
- **Marketplaces.** RBI's **April 2026 draft Directions** expressly narrow the
  closed-system carve-out to instruments issued by an entity *"other than a
  marketplace"*. If value ultimately settles to third-party sellers, an in-app
  wallet is almost certainly not closed-loop — and arguably already is not under
  the 2021 MD.
- **Onboarding third-party merchants** to accept your balance converts it to a
  semi-closed instrument requiring authorisation. The alternative is co-branding
  with an authorised issuer who holds the licence and the liability.

**The analytical test is whether funds were received against issuance:**

| Mechanic | Funds received? | Redeemable where? | Likely position |
| -------- | --------------- | ----------------- | --------------- |
| Points earned on spend | No | Issuer only | Outside PPI |
| Issuer-funded cashback credit | No | Issuer only | Outside PPI |
| Customer tops up with cash/card | **Yes** | Issuer only | Closed-system PPI (exempt from authorisation, but *is* a PPI category) |
| Customer tops up | **Yes** | Third parties / cash-out | **Regulated — licence required** |
| Gift voucher sold, single brand | **Yes** | Issuer only | Closed-system PPI |
| Gift voucher sold, multi-brand | **Yes** | Multiple entities | **Regulated — licence required** |

Points *earned* and redeemable only against your own goods are conventionally
outside the framework. **Value *purchased* is the risky side.** There is no de
minimis threshold, so there is no safe harbour by size.

**If authorisation is needed** (non-bank): incorporated in India with PPI
issuance in the MoA, minimum positive net worth **₹5 crore at application** and
**₹15 crore by the end of the third financial year**, a separate INR escrow
account with a scheduled commercial bank used **only** for PPI business with no
co-mingling, day-end escrow at least outstanding PPIs plus merchant dues, and
**quarterly statutory auditor certification**.

**Three more that bite:**

- **Credit-line loading is prohibited** (RBI letter, 20 June 2022). Credit
  *cards* remain a permitted load source; credit lines and loans are not. This
  killed a swathe of PPI-linked BNPL.
- **Unclaimed balances cannot go to P&L for at least three years after expiry**
  (¶13.3) — stricter than most US states.
- **Refund direction matters.** A refund of a transaction paid *from* a PPI must
  be credited back to that same PPI immediately, **even if this breaches balance
  limits** — so the ledger must permit a credit that temporarily exceeds the cap.
  A refund of a transaction paid by *another* instrument must **not** be credited
  to a PPI. **You cannot refund a card payment into a regulated wallet.**

**Status warning:** draft Directions were issued 22 April 2026 with comments
closed 22 May 2026; the research found no evidence they have been finalised.
Proposed changes include simplified categories, marketplaces excluded from the
closed-system carve-out, cross-border PPI transactions eliminated, and
credit-card loading of general-purpose PPIs prohibited. **Verify current status
on rbi.org.in before acting.**

### 14.2 United States — four separate regimes

**Exemption under one is not exemption under another.**

**(1) FinCEN prepaid access.** Closed-loop prepaid access of **$2,000 or less**
is excluded from the definition of a prepaid program; the threshold attaches to
the *device*, not the person. Separately, you are a "seller of prepaid access" —
**including closed-loop** — if you sell more than **$10,000 to any person in one
day** without adequate policies.

**(2) State money transmitter licensing.** The best framing found, from the ABA:
***"The product is closed-loop. The operator may not be."*** The closed-loop
exemption describes the *instrument*; whether the *entity* is a money transmitter
is a separate analysis about whether you take money from one person and send it
to another. Single-brand store credit issued by the entity that supplies the
goods is exempt essentially everywhere; multi-merchant wallets, cash-out, P2P
transfer and bank-refundable balances are regulated almost everywhere. **Florida
is the binding constraint for any national programme** — neither a clean
closed-loop exemption nor an express agent-of-the-payee exemption, and a
regulator that looks at economics rather than contract language. Cost of being
wrong: surety bonds of $10,000–$500,000 per state, up to $7m in California.

**(3) CARD Act / Regulation E.** Minimum **five-year life** from issuance or the
most recent load, with a reload restarting the clock. Dormancy fees only after a
year of inactivity, clearly disclosed, no more than one per month. If a card
expires with funds remaining, replace it or refund at no cost.

**(4) Escheatment — the liability nobody models.** This is a balance-sheet item
and it **caps breakage revenue.** Roughly 37 states exempt gift cards or have no
escheat law; about 14 jurisdictions require it.

Under *Texas v. New Jersey*, unclaimed balances escheat first to the owner's last
known address, and **second to the holder's state of incorporation.** For gift
cards you usually have no owner address, so everything falls to second priority —
for most US companies, **Delaware, which escheats at COGS rather than face
value, five years after the last indication of interest.**

**Two architectural consequences.** Capturing the purchaser's address at sale
means first priority applies and the balance may escheat to an exempting state;
capturing nothing sends it all to Delaware. That is a data-capture decision with
a direct dollar consequence, and it cannot be done retroactively. And many state
exemptions are **conditional on the card having no expiry and no dormancy fee** —
so adding either can forfeit the exemption across multiple states. A product
decision with a price tag.

Your ledger needs, per balance: funding source, issue date, **last-activity
timestamp** (you must be able to *evidence* "indication of interest"), issuing
jurisdiction, purchaser address if available, and original face value separately
from current balance.

### 14.3 European Union

**EMD2 Art 2(2)** defines electronic money as value issued on receipt of funds
and **"accepted by a natural or legal person other than the issuer."** Store
credit accepted only by the issuer fails that limb and is outside the definition
on its face.

**PSD2 Art 3(k)** — the limited network exclusion — has three mutually exclusive
limbs: premises of the issuer, a limited network of service providers under
direct commercial agreement, or a very limited range of goods with a "direct
functional connection". Under EBA/GL/2022/02 the assessment indicators are
mandatory and **each one can independently be a reason to refuse** the exclusion.

**The engineering requirement:** commentators note that **technical *and*
contractual restrictions are required cumulatively.** Your system must be
*incapable* of settling outside the network, not merely contractually forbidden
from doing so.

**The €1,000,000 figure is a notification trigger, not an authorisation
threshold** — and EBA Guideline 6.1 says notify **at the moment the threshold is
exceeded**, not at the end of the 12-month period, which corrects a common
misreading.

### 14.4 Where architecture and regulation meet

Five decisions forced by regulation that cannot be retrofitted:

1. **Split the wallet liability** into cash-funded / promotional / refund-sourced.
   Drives escrow sizing (India), permissible-investments backing (US),
   safeguarding (EU), breakage recognition (ASC 606) and escheat reporting.
2. **Capture purchaser address and funding source at issuance.**
3. **Record `last_activity_at`** and be able to evidence indication of interest.
4. **Make the closed-loop boundary a system property, not a policy.** If your
   settlement code *can* pay a third party, you are relying on a contract the
   regulator will discount.
5. **Reconcile escrow to wallet liabilities daily and alarm on divergence.**
   Treating it as a month-end accounting task is a breach waiting to be found by
   an auditor rather than by you.

---

## 15. Accounting — points are a liability

Under both IFRS 15 and ASC 606, points conferring a **material right** are a
separate performance obligation. Part of the transaction price is allocated to
them and deferred until redemption or expiry.

**Breakage (IFRS 15 B46) has two branches**, and getting this wrong is the most
common error:

- If you **expect to be entitled** to breakage, recognise it **in proportion to
  the pattern of rights exercised** — you do *not* wait for expiry.
- If you **do not**, recognise only when the likelihood of exercise becomes
  **remote**.

Either way it is subject to the variable-consideration constraint. And in the US,
**breakage may only be recognised to the extent you are not required to remit the
amount to a state** — escheat exposure is a hard cap on breakage revenue.

### 15.1 The real numbers, from filings

| Program | Breakage | Note |
| ------- | -------- | ---- |
| AIR MILES | ~33% → 28% (2010) → 26% → **20%** (Dec 2016) | Mile life estimated 42 → 38 months |
| Aeroplan | **12%** weighted average (2013 & 2014) | |
| Delta SkyMiles | Rate not disclosed | Deferred balance **$8.8B** at 2024-12-31 |
| Starbucks | Rate not disclosed | Breakage revenue FY2025 $200.4M + $22.0M licensed |

**Range roughly 12–33%, clustering near 20%.** Coalition programs with long or no
expiry sit low-to-mid; short-expiry retail sits higher.

### 15.2 The sensitivities — why this belongs in an engineering doc

- **Marriott:** a **1 percentage point** decrease in the breakage estimate →
  **~$50M increase** in the loyalty liability.
- **AIR MILES:** a **one-month** change in estimated mile life → ~$5M of revenue.
- **AIR MILES, the big one:** cancelling the five-year expiry policy forced
  breakage from 26% to 20%, *"increas[ing] the deferred redemption liability by
  **$284.5 million** with a corresponding reduction of redemption revenue in
  December 2016."*
- **Aeroplan:** a Q2 2013 breakage estimate change **reduced revenue from loyalty
  units by $642.1 million.**

**A product decision to remove or extend point expiry is a nine-figure revenue
event.** Expiry policy must be change-controlled with Finance, versioned, and
effective-dated in the schema — never a config toggle.

Estimation is a loss-reserving problem: cohort the points into chain-ladder
triangles, either by issuance period (constant denominator) or by member join
period (growing denominator, requiring an explicitly chosen terminal period).
Note that marketing campaigns distort these triangles along **calendar
diagonals**, not cohort rows.

### 15.3 Coalition settlement

In a coalition the **operator owns the currency and the liability**; merchants
are issuers (buying points) or redeemers (paid when points are spent). Operator
revenue is the issuance fee margin plus breakage.

AIR MILES' disclosure reveals the architecturally important fact: **two contract
shapes produce different liabilities.**

| Contract shape | Cash timing | Operator's liability |
| -------------- | ----------- | -------------------- |
| **Full prepay at issuance** | 100% on issue | Operator carries the full redemption liability and keeps breakage |
| **Split issuance/redemption** | Part on issue, part on redemption | Operator carries **no redemption obligation** |

Points are fungible to the member but **not fungible for liability purposes.**
Because the member burns earliest-expiry-first without regard to contract, **the
consumption-link table from §7.1 is the only thing that lets Finance attribute
each redemption back to its issuing contract.** Without it, split-model
settlement is not computable.

**Principal versus agent is determined at the moment of redemption, not at
issuance** — because before redemption the goods to be provided are unknown. So
the redemption event must carry fulfilment party, control indicator and the
negotiated settlement rate for Finance to classify gross versus net per
redemption. Retrofitting that is extremely painful.

---

## 16. Abuse, and why the controls must be shared

### 16.1 The organising insight

**Abuse is cross-program, so limits must be cross-program.** A fraudster does not
care whether the subsidy comes from referrals, loyalty, coupons, trials or
credits — they optimise **total extraction per identity**. If each program keeps
its own limits, the attacker simply spreads across programs.

Six primitives, built once and shared by every program:

1. **Canonical identity record and identity graph.** One normalised identity per
   human, built from canonicalised email, phone, address, card fingerprint and
   device. Risk scoring without unified identity context is just another alerting
   system.
2. **Eligibility service.** One service answering *"may this identity receive
   this benefit, now, at this value?"* Every program calls it; no program
   implements its own.
3. **Unified incentive ledger.** Every grant and reversal across all programs in
   one append-only ledger, so **lifetime subsidy per identity** is a computable
   number. That number, not per-program spend, is the metric abuse shows up in.
4. **Shared risk score with calibrated bands**, calibrated against labelled
   outcomes *before* attaching friction. Graduated response: soft rate limit →
   challenge → step-up verify → review → block. Score *velocity* can matter more
   than score level.
5. **Velocity service** with pluggable keys and windows, enforcing both count and
   value caps, keyed on account, device, IP /24, ASN, canonical email, phone,
   card fingerprint, shipping address and payout destination.
6. **Review queue and label store.** The decisions reviewers make are the
   training data. Without a label store the models never improve and you can
   never measure your false-positive rate.

Plus budget guardrails with a kill switch that halts issuance atomically (both
legs, for double-sided), and an immutable audit trail of who approved or reversed
what and why.

**Retrofitting cross-program caps is close to impossible**, which is the whole
argument for building these before the first program ships.

### 16.2 Entity resolution comes before any graph

Canonical email (Gmail is dot-insensitive, strips `+tags`, and `@googlemail.com`
is the same mailbox — a uniqueness check on the raw string gives one Gmail user
unlimited accounts), E.164 phone, normalised address, card fingerprint,
normalised device id.

**Store the raw value for delivery, compare on the normalised one, and treat the
normalised key as a *duplicate signal*, not an identity.** Over-canonicalising
merges real distinct users.

Stripe's card `fingerprint` is the highest-precision signal available — it
"uniquely identifies this particular card number" across customers. Its
documented caveats matter: for Apple Pay and Google Pay the *tokenised* number
may be fingerprinted instead, and Indian Connect cards have two fingerprints. So
collision is high-precision but **not complete**.

### 16.3 Ring detection — and why the naive graph fails

**Do not run plain connected components over all edge types.** The documented
failure mode: linking accounts through shared devices, cards, addresses and IPs
produces *"a single component holding most of your customers… It is not wrong
about the links; it is wrong about what a link means."*

What works:

- **Split edges by precision.** High-precision (card fingerprint, device id,
  payout account, exact address) → union-find connected components directly.
  Low-precision (IP, ASN, email domain) → weight, do not link.
- **IDF-weight the hub nodes**, so a shared attribute held by thousands of
  accounts contributes almost nothing.
- **Cap hub degree** — drop any attribute node above N accounts, which is how you
  exclude office NAT, carrier-grade NAT, dorms and shared family cards.
- **Community detection inside components** (Louvain) — with the caveat that five
  random seeds produce five different partitions at near-identical modularity, so
  partitions must be validated against labelled cases, not trusted raw.

**Two papers are worth knowing.** **FRAUDAR** (KDD 2016 Best Research Paper)
finds dense blocks in a bipartite adjacency matrix and provides **provable upper
bounds** on what fraudsters can achieve even when they camouflage by linking to
honest accounts. **SynchroTrap** (CCS 2014) is the best independent evidence that
this class of method works in production: it clusters accounts by **loosely
synchronised action timing** rather than shared attributes, was deployed at
Facebook and Instagram for over ten months, and **in one month uncovered more
than 2 million malicious accounts across 1,156 campaigns, with manual review of a
random sample suggesting precision above 99%.**

For referrals the analogue is clustering advocates whose referees signed up and
qualified in the same narrow time bins with the same action sequence.

**Score clusters, do not auto-ban.** Rank by size × density × unpaid reward
exposure, route the top N to review, feed decisions back as labels.

### 16.4 The constraint everyone understates

Aggressive IP blocking hits legitimate households; strict one-bonus-per-device
rules penalise family members sharing a computer. The graph literature says the
same thing in different words: **a shared attribute does not imply
coordination.**

This is why every credible source recommends **multiple correlated signals before
a hard block**, and why the right default action is **hold for review, not ban**.
A risk-based alternative worth copying: withhold or *reduce* the offer for
high-risk registrants rather than hard-blocking.

**No published false-positive rates exist** for device-based multi-accounting
detection in consumer referral contexts. Given the shared-household problem, that
is the number you would most want and the one nobody publishes.

### 16.5 Code leakage and attribution hijacking

Codes escape their intended context via email forwards, affiliate feeds,
influencer posts, scraping, and **coupon-testing browser extensions that
automatically try known codes at checkout.** Controls: partner-locked and
single-use codes, commission reversal plus warning on leak, monitoring of
*internal* codes (staff, friends-and-family), redemption caps and expiry, and
rotating code patterns with full deactivation of old ones.

**Attribution hijacking attacks the attribution layer directly** — cookie
stuffing, forced redirects, link injection, brand bidding. The landmark matter is
*In re PayPal Honey Browser Extension Litigation* (N.D. Cal. 5:24-cv-09470),
consolidating 25+ creator suits filed January 2025, alleging a hidden browser
interaction replaced the existing affiliate identifier at checkout in breach of
affiliate-agreement stand-down provisions. **Nothing is proven and PayPal has not
been found liable**; procedural history is contested across sources. The
defensive controls are click-path and timing audits, last-touch de-duplication
that demotes suspicious final touches, and attribution windows tight enough that
a click which cannot plausibly precede a purchase earns nothing.

---

## 17. What this means for Wouchh

**This section is a reading of the evidence, not an agreed plan.** We are
greenfield here — there is no loyalty, coupon, wallet or referral code in the
repository today — which means the ordering decisions in §3 are still free.

### 17.1 Build the ledger once

We already have ledger discipline in this codebase: dedup keys, lease claiming
with `FOR UPDATE SKIP LOCKED`, dead-lettering, CAS on from-status, and
`affected > 0` guards. **The engagement ledger is the same spine** with
`tenant_id` in every primary key and every index.

Points, wallet value, promotional credit and referral rewards are entry types on
one ledger, not four systems. The §4 fix is the pattern already used in
`message.repository.ts` and the reconciliation services — the conditional
single-statement mutation with an `affected > 0` check.

### 17.2 Three things forced by our specific situation

**India changes the wallet question, not the loyalty question.** Points earned
against our own services sit outside the RBI PPI framework. Value *purchased* is
the risky side, and the four-condition test in §14.1 is all-or-nothing. For a
multi-tenant B2B platform the specific traps are: balances that settle
obligations to a third party, balances that move between tenants, and group
entities treated as one issuer. **This is a product-boundary decision to make
before schema, not after**, and if we go near purchased value it wants Indian
counsel rather than this document.

**Our tenant-isolation blind spot is confirmed as structural, not incidental.**
§11.1 documents Talon.One scoping campaigns and activity per Application while
customer profiles span Applications. That is precisely the pattern in
`docs/` and our own isolation notes: *A using its own row to reach a shared
global object.* In an engagement system the shared objects are the identity graph
and the incentive ledger. **`tenant_id` belongs in the primary key, not only in a
`WHERE` clause**, and the isolation tests need a case that asks whether two
tenants can reach one shared object — not only whether one can read the other's
row.

**Anti-abuse primitives must be shared from the start.** §16.1. The identity
graph, eligibility service and unified ledger are infrastructure, not features of
the first program.

### 17.3 Sequencing, if we build this

1. **Ledger + identity + eligibility service** — the shared spine, with the
   bypass write path from §3.4 included from day one.
2. **One program on top of it** to prove the shape. **Referrals is the cheapest
   first program**, because its reward state machine (§7.9) exercises hold,
   qualify, reverse and clawback — everything the other programs need — without
   requiring a cart, a tax calculation or a regulated balance.
3. **The rest as policy, not new systems.**

### 17.4 House-rule notes

Device identifiers, IP addresses and card fingerprints are **sensitive
identifiers** under our logging rules — hash or mask them, and never log raw
email, phone or address. Toast's precedent in §11.3 is worth adopting: the
identifier exchanged with an external system must not itself contain PII.

Expiry policy, per §15.2, is a Finance-controlled and effective-dated schema
concern, not a config flag.

---

## 18. What could not be verified

Recorded because a research document that hides its gaps is worse than one that
admits them.

**Blocked sources.** `developer.salesforce.com` returns 403 to automated fetches,
so all Salesforce object-model detail comes from search extracts rather than
direct reads — the names are consistent across many API versions but the
field-level semantics should be re-checked. SAP Emarsys' developer portal is a
client-rendered SPA that yielded **zero** field names or schemas. EUR-Lex blocked
every route to the verbatim PSD2 Art 3(k) and Art 37(2) text, so §14.3 rests on
EBA guidelines and law-firm quotation. Lightspeed R-Series returned 403 on all
paths. Zinrelo's authoritative pages sit behind bot protection.

**Regulatory status.** Whether RBI's 2026 draft PPI Directions have been
finalised — no evidence found that they have; the 2021 MD appears operative.
Whether issuer-funded promotional credit may be credited to escrow in India —
not addressed in the Master Direction or FAQ. Delaware's current de minimis
gift-card threshold. Montana's money transmitter status (sources directly
contradict). Which 14 jurisdictions require gift-card escheat (count published,
list not). Escheat exposure for *loyalty points* specifically — asserted by
vendor guides, found in no primary source.

**Vendor behaviour.** Square publishes no rate limits ("we don't document the
limits"). Capillary's production rate limits are per-brand and unpublished.
Shopify's behaviour when a function errors or exceeds limits is **not officially
documented** — a third-party claim of fail-open is uncorroborated and that same
source contradicts Shopify's own docs on three counts, so **test it before
depending on it**; a silently-dropped discount is hard to detect. Two official
Shopify pages disagree on function input size (128 kB vs 64,000 bytes), likely an
API-version difference. Talon.One's per-customer *database* isolation is not
stated — only VPC-level.

**Claims that did not survive checking.** The vendor consensus that two-sided
referral rewards always outperform has **no underlying study** behind it. Formal
NP-hardness for retail discount stacking is **not proven** anywhere found. Branch
NativeLink's near-100% iOS match rate and all MMP match-rate claims are vendor
marketing with no independent benchmark. The widely-repeated Forter loyalty-fraud
figures trace back to a few original surveys and are often presented as current.

**Structural gaps.** Coalition settlement mechanics — netting cycles, file
formats, per-point rates — are contractual and not publicly disclosed. **No
vendor publishes its rule-authoring DSL** in its API reference; invocation and
tracing are public, the grammar lives in the UI. That is a deliberate product
decision, and it means "rules-as-code" is genuinely unserved in this market.
**No published loyalty-engine latency SLA exists** beyond Toast's, and Toast's is
a requirement imposed on integrators rather than a vendor commitment.

---

## 19. Sources

**Regulatory and accounting primary**
RBI [Master Directions on PPIs](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12156) ·
RBI [PPI FAQs](https://www.rbi.org.in/commonman/english/scripts/FAQs.aspx?Id=2812) ·
[FinCEN prepaid access rule](https://www.federalregister.gov/documents/2011/07/29/2011-19116/bank-secrecy-act-regulations-definitions-and-other-regulations-relating-to-prepaid-access) ·
[12 CFR 1005.20](https://www.consumerfinance.gov/rules-policy/regulations/1005/20/) ·
[12 Del. C. § 1133](https://www.lawserver.com/law/state/delaware/de-code/delaware_code_title_12_1133) ·
[EBA Guidelines on the limited network exclusion (EBA/GL/2022/02)](https://www.eba.europa.eu/publications-and-media/press-releases/eba-publishes-final-guidelines-limited-network-exclusion) ·
[IATA IAWG IFRS 15 Guidance, 5th ed.](https://www.iata.org/contentassets/4a4b100c43794398baf73dcea6b5ad42/iawg-guidance-ifrs-15.pdf) ·
[Deloitte on ASC 606 breakage](https://dart.deloitte.com/USDART/home/codification/revenue/asc606-10/roadmap-revenue-recognition/chapter-8-step-5-determine-when/8-8-customers-unexercised-rights-breakage) ·
[ABA — When Selling Gift Cards Makes You a Money Transmitter](https://businesslawtoday.org/2026/07/when-selling-gift-cards-makes-you-a-money-transmitter/)

**SEC filings**
[Delta FY2024 10-K](https://www.sec.gov/Archives/edgar/data/27904/000002790425000004/dal-20241231.htm) ·
[Alliance Data (AIR MILES) FY2017 10-K](https://www.sec.gov/Archives/edgar/data/0001101215/000110121518000066/ads-20171231x10k.htm) ·
[Starbucks FY2025 10-K](https://www.sec.gov/Archives/edgar/data/829224/000082922425000114/sbux-20250928.htm) ·
[Marriott FY2024 10-K](https://www.sec.gov/Archives/edgar/data/1048286/000162828025004818/mar-20241231.htm) ·
[Aimia Q4 2014 MD&A](https://aimia.com/wp-content/uploads/2014/10/Aimia-Q4-2014-MDA-Filings-r296_BOD.pdf)

**Peer-reviewed and actuarial**
[SynchroTrap, CCS 2014](https://users.cs.duke.edu/~xwy/publications/SynchroTrap-ccs14.pdf) ·
[FRAUDAR, KDD 2016 Best Paper](https://db.cs.cmu.edu/2016/08/cmu-wins-sigkdd-best-research-paper-award/) ·
[Schmitt, Skiera & Van den Bulte, *Journal of Marketing* 2011](https://faculty.wharton.upenn.edu/wp-content/uploads/2012/04/Schmitt-Skiera-vandenBulte-2011-Referral-Programs-Customer-Value.pdf) ·
[Jin & Huang, *JAMS* 2022](https://link.springer.com/article/10.1007/s11747-022-00852-z) ·
[CAS — Loyalty Rewards and Gift Card Programs](https://www.casact.org/sites/default/files/database/forum_12sumforum_gault_llaguno_menard.pdf) ·
[Serializable Snapshot Isolation in PostgreSQL](https://arxiv.org/pdf/1208.4179)

**Security advisories**
[GHSA-7mp4-25j8-hp5q — Sylius promotion usage race (CVE-2026-31824)](https://github.com/Sylius/Sylius/security/advisories/GHSA-7mp4-25j8-hp5q) ·
[CVE-2026-55795 — Craft Commerce coupon rate-limit bypass](https://feedly.com/cve/CVE-2026-55795)

**Machine-readable API specs**
[Talon.One Integration API](https://docs.talon.one/oas/integration.yaml) ·
[Talon.One outbound notifications](https://docs.talon.one/oas/outbound-notifications.yaml) ·
[Toast Loyalty Integration API](https://doc.toasttab.com/toast-api-specifications/toast-integrations-loyalty-api.yaml)

**Vendor developer documentation**
[Talon.One effects](https://docs.talon.one/docs/dev/integration-api/api-effects) ·
[Talon.One customer sessions](https://docs.talon.one/docs/dev/concepts/entities/customer-sessions) ·
[Talon.One negative points](https://docs.talon.one/docs/product/loyalty-programs/profile-based/use-negative-points) ·
[Talon.One campaign budgets](https://docs.talon.one/docs/product/campaigns/settings/manage-campaign-budgets) ·
[Voucherify loyalty points](https://docs.voucherify.io/build/loyalty-points.md) ·
[Voucherify validation sessions](https://docs.voucherify.io/guides/locking-validation-session) ·
[Voucherify limits](https://docs.voucherify.io/guides/limits.md) ·
[Voucherify import orders](https://docs.voucherify.io/api-reference/orders/import-orders.md) ·
[Shopify Discount Function API](https://shopify.dev/docs/api/functions/2026-10/discount) ·
[Shopify Functions performance and resilience](https://shopify.dev/docs/apps/build/functions/input-output/network-access/performance-and-resilience) ·
[Shopify webhooks](https://shopify.dev/docs/apps/build/webhooks) ·
[Toast latency requirements](https://doc.toasttab.com/doc/devguide/apiLoyaltyLatencyRequirements.html) ·
[Toast idempotence](https://doc.toasttab.com/doc/devguide/apiLoyaltyIntegrationNetworkFailureAndIdempotence.html) ·
[commercetools Cart Discounts](https://docs.commercetools.com/api/projects/cartDiscounts) ·
[commercetools query predicates](https://docs.commercetools.com/api/predicates/query) ·
[Square loyalty events](https://developer.squareup.com/docs/loyalty-api/loyalty-events) ·
[Saleor price calculation](https://docs.saleor.io/developer/price-calculation) ·
[Medusa promotion concepts](https://docs.medusajs.com/resources/commerce-modules/promotion/concepts) ·
[Vendure promotions](https://docs.vendure.io/current/core/core-concepts/promotions) ·
[Elastic Path promotions (Drools)](https://documentation.elasticpath.com/commerce/docs/core/platform/commerce-manager/promotions.html) ·
[Antavo API events](https://developers.antavo.com/docs/api-events) ·
[Capillary promotions evaluate](https://docs.capillarytech.com/reference/post_api-gateway-v1-promotions-evaluate) ·
[Open Loyalty architecture](https://raw.githubusercontent.com/apoorvanand/OpenLoyalty/master/backend/doc/developer/architecture/overview.rst) ·
[Oracle Siebel rolling-period tiers](https://docs.oracle.com/cd/G30561_01/books/LoyaltyAdmin/c-Example-of-Creating-a-Rolling-Period-Based-Tier-Assessment-Model-od1151198.html)

**Ledger and payments engineering**
[TigerBeetle two-phase transfers](https://docs.tigerbeetle.com/coding/two-phase-transfers/) ·
[Jepsen: TigerBeetle 0.16.11](https://jepsen.io/analyses/tigerbeetle-0.16.11) ·
[Modern Treasury — ledger balances](https://www.moderntreasury.com/journal/how-to-think-about-ledger-balances) ·
[Modern Treasury — enforcing immutability](https://www.moderntreasury.com/journal/enforcing-immutability-in-your-double-entry-ledger) ·
[Formance — ledger balance architecture](https://www.formance.com/blog/financial-operations/ledger-balance-for-product-and-engineering) ·
[Uber payments platform](https://www.uber.com/us/en/blog/ubers-payments-platform/) ·
[Square Books — immutable double-entry accounting](https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/) ·
[Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests) ·
[Stripe Card object (fingerprint)](https://docs.stripe.com/api/cards/object) ·
[Google Play Install Referrer](https://developer.android.com/google/play/installreferrer/library)
