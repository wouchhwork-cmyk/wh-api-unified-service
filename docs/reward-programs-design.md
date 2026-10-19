# Reward Programs — Design

Enterprise configures: **what customer does → what they get → how often.**
Activity comes from the Meta integration we already have. Value lands in a
ledger. Nothing built yet.

Research behind it: [`engagement-programs-market-study.md`](./engagement-programs-market-study.md).
Schema conventions: [`schema.md`](./schema.md).

---

## 1. Decisions taken

| Question | Answer |
| -------- | ------ |
| Variable awards | **Cap × factor.** Factor function returns `[0,1]`. V1 returns `1.0` |
| Money | **Enterprise owes the customer. Redeemable only with that enterprise.** Closed loop |
| Wouchh holds float? | **No.** We record the obligation, we do not custody money |
| V1 scope | Full config surface. Forwarding + item redemption are seams |
| Benefits per rule | **1:N.** A rule owns ordered benefits, applied all-or-nothing |
| Effect config storage | **Typed discriminator + `config JSONB`**, validated on write, read and in CI |
| Catalogue size | Everything configured; expect most of it to stay unused (§17) |
| Table prefix | `reward_*` — `customer_engagements` already means something else |

---

## 2. What already exists

```
   ALREADY BUILT                              NEW
   ─────────────                              ───
   customers ─────────────────────────────▶  reward member  (same row, no mapping)
   messages ──┐
   posts ─────┼──▶ trigger normaliser ────▶  reward_awards
   inbound_events (dedup) ─────────────────▶ (free idempotency at transport)
   outbound_events + SKIP LOCKED poller ──▶  reward forwards (one enum value)
```

**The reward member IS a `customers` row.** No identity table, no resolution.

Meta issues page-scoped IDs → same human has a different IGSID per business →
`customers` is already `enterprise_id NOT NULL` → **cross-tenant reward leakage
cannot be expressed.** Not a test we maintain. A shape that does not exist.

---

## 3. The flow

```
 webhook          domain row        normalised       rules            benefits        ledger
   │                  │               event            │                 │             │
   ▼                  ▼                 ▼              ▼                 ▼             ▼
┌────────┐      ┌───────────┐     ┌───────────┐  ┌──────────┐    ┌────────────┐  ┌─────────┐
│inbound_│─────▶│ messages  │────▶│  TRIGGER  │─▶│ match +  │───▶│ GRANT_     │─▶│ entry + │
│events  │ dedup│ posts     │     │  (13 of   │  │ cap +    │    │ POINTS     │  │ wallet  │
│        │      │           │     │   them)   │  │ budget   │    │ ISSUE_ENT  │  │         │
└────────┘      └───────────┘     └───────────┘  └──────────┘    └────────────┘  └─────────┘
                                                        │                 │
                                                   claim slot        dispatcher
                                                  (atomic SQL)     (one applier +
                                                                    one compensator)
```

**Three registries, one descriptor.** Triggers, conditions and benefits are three
registries over the *same* `ConfigurableOperationDef`-shaped base — the single
highest-leverage structural decision in the research. Vendure runs **nine**
registries on one descriptor, one form engine, one persistence shape. The second
extension point then costs almost nothing, and every improvement to the form
engine lands everywhere at once.

Two rules:

1. **Rules reference the trigger catalogue, never Meta payload shapes.** Meta
   changes → one mapper breaks, not every rule an enterprise wrote.
2. **Rule engine emits benefits. A dispatcher applies them.** Adding items later =
   filling in one applier. Nothing above it moves.

---

## 4. Naming

Per [`schema.md`](./schema.md), and these are rules, not preferences:

| | |
| --- | --- |
| Database | `snake_case` |
| Code | `camelCase` — mechanical, lossless both ways |
| Tables | plural `snake_case` |
| Classifier | `<noun>_kind`, **never a bare `type`** |
| Lifecycle | `status` — bare `state` is taken (`enterprises.state` is an address) |
| Boolean | `is_` / `has_`, never negated |
| Timestamp | `<past_participle>_at`, or `_until` for a deadline (`locked_until`) |
| Count | `<noun>_count` |
| Open JSONB | only `metadata`, `payload`, `config` |
| Enum values | lower `snake_case` strings in `VARCHAR`, **validated in the service layer, not by `CHECK`** |
| Abbreviations | only `id`, `ref`, `url`, `ip`, `mime`. Everything else spelled out |

`ref_id` means **our** public identifier, so an external item reference is
`item_ref`, not `item_ref_id`.

> **One tension to note.** §8.5 uses `CHECK` constraints to tie `account_kind` to
> the presence of `customer_id` / `destination_id`. The rule above forbids
> `CHECK` for *validating the allowed enum set* — these do not do that, they
> enforce a structural invariant between columns. Keeping them, but it is a
> judgement call worth a second opinion.

---

## 5. Enums

```ts
/** What the customer did. Audited against SUBSCRIBED_FIELDS + the projectors. */
export enum RewardTriggerKind {
  DirectMessageInbound   = 'direct_message_inbound',
  StoryReply             = 'story_reply',               // replied to OUR story
  StoryMention           = 'story_mention',             // mentioned us in THEIR story
  MessageReaction        = 'message_reaction',
  PostbackTapped         = 'postback_tapped',           // ice breaker / button
  OptInGranted           = 'opt_in_granted',            // consent event
  ReferralEntry          = 'referral_entry',            // ad / ref link / QR
  CommentOnOwnPost       = 'comment_on_own_post',
  CommentOnMentionedPost = 'comment_on_mentioned_post', // their post, tags us
  PostTaggingUs          = 'post_tagging_us',
  PostCaptionMention     = 'post_caption_mention',      // inert until E8
  PostLike               = 'post_like',                 // BLOCKED — backlog 8.2
  PostShare              = 'post_share',                // BLOCKED — backlog 8.2
}

export enum ProgramStatus {
  Draft  = 'draft',    // never switched on
  Active = 'active',   // switched on. SAYS NOTHING about being in window
  Paused = 'paused',   // manually suspended
  Archived = 'archived',
}
// NOT a status: 'ended' / 'scheduled'. Both are derived from the dates (§8.1).
// Two answers to one question is how they drift.

/** Whether an event QUALIFIES. Flat AND list per rule (§8.9). */
export enum RewardConditionKind {
  TimeWindow     = 'time_window',       // day-of-week + local wall-clock window
  CustomerTenure = 'customer_tenure',   // "must have engaged before today"
  ContentMatch   = 'content_match',     // keyword in the comment or caption
}

/** What a benefit DOES. One entry per applier. */
export enum RewardBenefitKind {
  GrantPoints      = 'grant_points',
  GrantCurrency    = 'grant_currency',
  IssueEntitlement = 'issue_entitlement',
  ConvertValue     = 'convert_value',
}

/** Two thirds of a mature loyalty engine is irreversible (§12.4). Type it. */
export enum Reversibility {
  Compensable = 'compensable',   // has a compensator, required by the type
  Pivot       = 'pivot',         // cannot be undone; must carry irreversibleBecause
}

export enum BenefitStatus {
  Applied = 'applied', Compensated = 'compensated',
  Failed = 'failed', Dead = 'dead',
}

export enum AwardMode   { Fixed = 'fixed', UpTo = 'up_to' }
export enum CapScope {
  Lifetime = 'lifetime', Day = 'day', Week = 'week',
  Month = 'month', Year = 'year', None = 'none',
}

export enum AwardStatus {
  Held              = 'held',
  Granted           = 'granted',
  Reversed          = 'reversed',
  SkippedCap        = 'skipped_cap',
  SkippedBudget     = 'skipped_budget',
  SkippedCondition  = 'skipped_condition',      // reason_code names which (§9.4)
  SkippedZeroFactor = 'skipped_zero_factor',
  Expired           = 'expired',
}

export enum ReversalPolicy { None = 'none', OnContentDeleted = 'on_content_deleted' }

export enum WalletKind  { Points = 'points', Currency = 'currency' }

/** Transit + External are house accounts. They have no customer. */
export enum AccountKind {
  Customer       = 'customer',
  SystemTransit  = 'system_transit',   // forwarded, not yet confirmed
  SystemExternal = 'system_external',  // confirmed gone to destination X
}

export enum RewardEntryKind {
  Earn        = 'earn',
  Burn        = 'burn',
  ConvertOut  = 'convert_out',   // paired
  ConvertIn   = 'convert_in',
  ForwardOut  = 'forward_out',   // paired, see §13
  TransitIn   = 'transit_in',
  TransitOut  = 'transit_out',
  ExternalOut = 'external_out',
  ForwardBack = 'forward_back',  // forward failed, value returns
  Reversal    = 'reversal',
  Adjust      = 'adjust',        // human, needs a permission
  TransferIn  = 'transfer_in',   // customer merge
  TransferOut = 'transfer_out',
}

export enum EntitlementStatus {
  Issued = 'issued', Reserved = 'reserved', Redeemed = 'redeemed',
  Expired = 'expired', Revoked = 'revoked',
}

export enum ForwardStatus {
  Pending  = 'pending',
  Sent     = 'sent',
  SentStub = 'sent_stub',   // noop provider. NOT a real send. §13.2
  Acked    = 'acked',
  Failed   = 'failed',
  Dead     = 'dead',
}

```

---

## 6. Triggers — audited against the handlers

### 6.1 What we subscribe to, what we consume

| Field | Projector | Customer acted? | Trigger |
| ----- | --------- | --------------- | ------- |
| `messages` | DM | yes | `direct_message_inbound`, `story_reply`, `story_mention` |
| `message_reactions` | `handleReaction` | yes | `message_reaction` |
| `messaging_postbacks` | `postbackAsMessage` | yes | `postback_tapped` |
| `messaging_optins` | DM | yes | `opt_in_granted` |
| `messaging_referrals` | `platformFacts.referral` | yes | `referral_entry` |
| `feed` item=`comment` | comment | yes | `comment_on_own_post` |
| `feed` item=`like` | **not modelled** | yes | `post_like` — blocked |
| `feed` item=`share` | post | yes | `post_share` — blocked |
| `mention` | mention flow | yes | `post_tagging_us`, `post_caption_mention`, `comment_on_mentioned_post` |
| `message_echoes` | DM | **no — that is us** | never |
| `message_reads` | — | **no — a read receipt** | never |
| `message_edits` | `handleEdit` | not new engagement | never |

IG arrives on the `instagram` object: `comments`, `mentions`, `messages`. Same
projectors.

### 6.2 Two worth noticing

**`referral_entry`** carries `ref` / `source` / `type` / `ad_id`, already stored
on `platformFacts`. That is **"scan this QR in store, get 50 points"** with zero
integration work left. Highest-value trigger in the list.

**`postback_tapped`** carries the `payload` set when the button was defined. So
a rule matches a *specific button* — "tap to claim" is a real flow, not keyword
matching on free text.

### 6.3 Excluded, with the reason

| Excluded | Why |
| -------- | --- |
| `message_echoes` | Sender is us. Would pay them for our activity |
| `message_reads` | Read receipt. Farmable by reopening a thread |
| `message_edits` | **Re-trigger attack** — post once, edit fifty times |
| verbs other than `add` | Those are reversal signals, §6.5 |
| `PermissionChange` | Infrastructure, not a customer |

### 6.4 Likes/shares: webhook arrives, we bin it

`feed` covers likes — our own comment in `meta-webhook.service.ts` says so.
But `item: 'like'` appears **nowhere in `src/`** outside `like_count`. It routes
to the post projector, `toPostKind` falls through to `PostKind.Text`, actor
discarded.

**We are told who liked a post and keep none of it.** Verify first —
[`todo.md`](./todo.md) **B4**; fix is backlog §8.2. Small either way.
`post_like` cannot ship until it is done. Caveats: Facebook only, and likes are
retractable → needs reversal on `remove` or it is free money.

### 6.5 Reversal signals already flow

`extractVerb` → `add` / `edit` / `hide` / `remove`, already part of the dedup
key. `applyModeration` already applies them.

| Meta verb | Normalised action | Award benefit |
| --------- | ----------------- | ------------ |
| `add` | — | trigger fires; an award is evaluated |
| `edit` | `edited` | none — §6.3 |
| `hide` | `hidden` | `Reversed`, `reason_code = content_hidden` |
| `remove` | `removed` | `Reversed`, `reason_code = content_removed` |
| `unhide` | `unhidden` | **none — reversal is terminal (below)** |

The normalised column is `applyPlatformModeration`'s own vocabulary
(`'edited' | 'removed' | 'hidden' | 'unhidden'`), so a rule reads the same words
the projector writes.

**`unhidden` deliberately does not re-grant.** Three reasons: re-granting needs a
fresh cap slot, which the customer has already consumed; hide/unhide cycling
would otherwise be a farming loop; and compensation is rarely symmetric anyway
(Talon.One never rolls back attribute writes or coupon creations). If an
enterprise genuinely wants the value restored, that is an `Adjust` entry with a
named actor and a permission behind it — visible, attributable, and rare. A
silent automatic re-grant is none of those.

**`hidden` is the cheapest abuse signal available.** Moderating a comment is a
judgement the enterprise was already making, and it costs them a click they were
going to spend regardless.

---

## 7. The award factor

```
   UP_TO rule says:  cap = 20 points
   FactorProvider:   factor ∈ [0, 1]
   award = round(cap × factor)

   V1 provider = constant_one → 1.0 → award = 20  (same as FIXED)
   later       = real engine  → 0.6 → award = 12
```

```ts
interface FactorProvider {
  readonly code: string;                        // stored per award
  factor(ctx: AwardContext): Promise<number>;   // [0, 1]
}
```

Integer only. Basis points:

```
factor_basis_points ∈ [0, 10000]            clamped AT THE BOUNDARY, not in the provider
award = (cap × factor_basis_points + 5000) / 10000        integer div, round half up
```

| Rule | Why |
| ---- | --- |
| Clamp on the way in | Provider returning `1.5` must not pay 30 on a cap of 20 |
| Evaluated at **grant time**, not event time | Metrics need time to settle |
| `factor_basis_points` + provider code + timestamp **snapshotted on the award** | "Why only 12 of 20?" must have an answer |
| **Zero factor does NOT consume the cap slot** | They did not earn. Releases with `GREATEST(used-1,0)` |

Zero-factor path is unreachable with `constant_one` → **test it now**, not when
the real provider first returns zero in prod.

**Why a factor beats a formula:** insights + `business_discovery` refuse with
Graph `#10`. A story someone else posted has **no readable metric**. A formula
would have excluded `story_mention` — the headline use case. A factor needs no
signal.

Engine implementation → backlog §8.1.

---

## 8. Schema

Conventions: `BIGSERIAL` PK, `enterprise_id BIGINT NOT NULL` leads every index,
composite FK `(x_id, enterprise_id)`, `is_deleted` + partial unique, UTC.

**`ref_id UUID` on anything a client addresses.** `UNIQUE NOT NULL DEFAULT
gen_random_uuid()`, exposed as `refId`. **The numeric `id` is never sent to a
client.** Plain `UNIQUE`, no `WHERE is_deleted` predicate — a random value is
never reused, so a dead row holding it forever is correct.

**The test is not "does a client read it" — it is "does a client hold a handle
and act on it".** `message_attachments` and `customer_engagements` are both read
by clients and have no `ref_id`, because they are reached through their parent
and never acted on directly.

| Has `ref_id` — acted upon | No `ref_id` — reached through a parent, or internal |
| ------------------------- | --------------------------------------------------- |
| `reward_programs` | `reward_cap_counters` — a mechanism. Read through the award that consumed it |
| `reward_rules` | |
| `reward_awards` | |
| `reward_wallets` | |
| `reward_ledger_entries` | |
| `reward_entitlements` | |

**`reward_ledger_entries` gets one, despite `schema.md` saying ledger tables do
not.** That exception is about *transport* ledgers — nobody reverses a webhook.
This is a financial ledger: `adjust` and `reverses_entry_id` both exist, so an
employee addresses **one specific entry** to reverse it, and a dispute has to be
able to name one. A handle is required.

**`reward_wallets` gets one** even though `customer_engagements` — the closest
structural analogue, also one row per customer per dimension — does not. The
difference is that an engagement row is a read-only projection, while a wallet
is **acted upon**: adjusted today, and redeemed against later.

**Two deliberate deviations from "every table has `is_deleted`":**
`reward_ledger_entries` (append-only has no delete, soft or otherwise) and
`reward_cap_counters` (§8.3).

### 8.1 `reward_programs`

| Column | Type | Note |
| ------ | ---- | ---- |
| id | BIGSERIAL | PK |
| ref_id | UUID | UNIQUE NOT NULL, `gen_random_uuid()` |
| enterprise_id | BIGINT | NOT NULL |
| name | VARCHAR(120) | |
| status | VARCHAR(16) | `ProgramStatus` — the switch, **not** the schedule |
| timezone | VARCHAR(64) | **resolves `period_key` AND every window**. Defaults from enterprise |
| default_currency_code | CHAR(3) | rule may override |
| budget_minor | BIGINT | NULL = uncapped |
| budget_currency_code | CHAR(3) | budget is counted in this |
| forward_provider_code | VARCHAR(40) | NULL = keep value here. `'noop'` in V1 |
| forward_config | JSONB | endpoint + mapping. **A secret reference, never a secret** |
| spent_minor | BIGINT | DEFAULT 0 |
| starts_at | TIMESTAMPTZ | NULL = already running. **May be in the future** |
| ends_at | TIMESTAMPTZ | NULL = no end |

```sql
UNIQUE (enterprise_id, lower(name)) WHERE is_deleted = false
```

### 8.2 `reward_rules`

| Column | Type | Note |
| ------ | ---- | ---- |
| id, enterprise_id, program_id | BIGINT | |
| ref_id | UUID | UNIQUE NOT NULL |
| version | INTEGER | **never edited in place** — awards point at a version |
| supersedes_rule_id | BIGINT | |
| trigger_kind | VARCHAR(40) | `RewardTriggerKind` |
| trigger_config | JSONB | **strict**, two keys — §8.2.1 |
| factor_provider_code | VARCHAR(40) | DEFAULT `'constant_one'`. One factor per award |
| cap_scope | VARCHAR(10) | `CapScope` |
| cap_count | INTEGER | DEFAULT 1 |
| hold_hours | INTEGER | DEFAULT 0 |
| reversal_policy | VARCHAR(20) | |
| priority | INTEGER | deterministic order when several match |

```sql
UNIQUE (enterprise_id, program_id, id, version)
INDEX  (enterprise_id, trigger_kind, priority, id) WHERE is_active AND NOT is_deleted
```

#### 8.2.1 What a trigger config may say

Two keys. Not an open bag.

```ts
RewardTriggerConfigSchema = z.strictObject({
  channelIds:       z.array(positiveInt).min(1).max(50).optional(),  // absent = every channel
  minPointsBalance: positiveInt.optional(),                          // balance trigger ONLY
})
```

Strict, and refused in both directions: `minPointsBalance` is **required** on
`points_balance_reached` and **rejected** on every other trigger. An open record
let a business save `{"postbackPayload":"WELCOME"}`, see it stored, see it read
back, and never learn the engine ignored it.

| | |
| --- | --- |
| absent `channelIds` | every channel the business owns |
| event with **no channel** vs a channel list | **no match** — "no channel" is not "any channel" |
| threshold rule, balance unknown | **no match** — fails closed, so only the producer can fire it |

### 8.3 `reward_rule_benefits` — what a rule awards

One row per benefit. Ordered. Applied all-or-nothing (§12.2).

| Column | Type | Note |
| ------ | ---- | ---- |
| id | BIGSERIAL | PK |
| ref_id | UUID | UNIQUE NOT NULL |
| enterprise_id, rule_id | BIGINT | NOT NULL, composite FK |
| rule_version | INTEGER | the rule version this benefit belongs to |
| benefit_index | SMALLINT | deterministic order — ledger entries land in a reproducible sequence |
| benefit_kind | VARCHAR(32) | `RewardBenefitKind`. **Plain VARCHAR — no CHECK**, so adding a kind is a code change |
| benefit_schema_version | SMALLINT | NOT NULL DEFAULT 1. **A sibling column, never a key inside the JSON** |
| award_mode | VARCHAR(10) | `fixed` / `up_to` — **per benefit** |
| award_cap | INTEGER | `up_to` only: the ceiling the factor scales |
| budget_cost_minor | BIGINT | NOT NULL DEFAULT 0 — what THIS benefit costs |
| config | JSONB | NOT NULL — the kind's payload. Zod-validated on write AND read |

```sql
UNIQUE (enterprise_id, rule_id, rule_version, benefit_index)
INDEX  (enterprise_id, rule_id, rule_version) WHERE is_deleted = false
```

**`award_mode` belongs here because scalability is a property of the benefit
kind.** `grant_points` and `grant_currency` are continuous — 0.6 × 20 = 12 means
something. `issue_entitlement` is discrete — 0.6 of a free
coffee means nothing. The kind declares whether it may be `up_to` and the
registry enforces it. With `award_mode` on the *rule*, a factor of 0.6 on
"20 points AND a free coffee" produced 12 points and six tenths of a coffee.

**`budget_cost_minor` belongs here too.** Per-rule, adding a fourth benefit left
the budget believing the rule cost what it did yesterday. An award claims the
**sum over its benefits**.

**Why JSONB and not typed columns.** Measured, not preferred:

- **Typed columns make every new benefit kind a migration.** Flagsmith built that
  (`operator` as a constrained column) and is spending 20 files and +2,498 lines
  escaping it.
- **The usual arguments for typed columns don't apply here.** Budget reads
  `budget_cost_minor` on the *rule*, not these payloads. Reporting reads
  `reward_ledger_entries.amount`, typed either way. And a `STORED` generated
  column extracted from `config` takes a composite FK — available the day an
  item catalogue exists, costing one index.
- **A typed discriminator plus a JSON payload is what the field converged on
  independently** — Unleash (`strategy_name` + `parameters jsonb`) and Vendure
  (`simple-json` + `ConfigurableOperation`).

**The gap everyone leaves, which we close.** Vendure persists args as
name/value strings and coerces on read with **no write-time check**. Rename an
arg and `argsArrayToHash` silently drops it while TypeScript asserts the
property is present — the exact `productIds → productId` divergence that
discredited the coupon engine we examined, sitting inside the reference
implementation. §11 is the answer.

### 8.4 `reward_award_benefits` — what actually happened

The dispatch record. One row per benefit applied, carrying its own undo.

| Column | Type | Note |
| ------ | ---- | ---- |
| id, ref_id | | |
| enterprise_id, award_id | BIGINT | NOT NULL |
| benefit_index | SMALLINT | copied from the rule benefit |
| benefit_kind | VARCHAR(32) | copied — the award must stay explainable if the rule changes |
| payload | JSONB | the resolved benefit, after the factor |
| status | VARCHAR(16) | `BenefitStatus` |
| **compensation** | JSONB | **what the applier produced, needed to undo it** |
| compensates_benefit_id | BIGINT | set on a compensating row |
| idempotency_key | TEXT | NOT NULL |
| applied_at_utc / compensated_at_utc | TIMESTAMPTZ | |

```sql
UNIQUE (enterprise_id, idempotency_key)
UNIQUE (enterprise_id, award_id, benefit_index)
```

**Record the outcome, reverse the record — never recompute it.** If a
compensator re-derives what to undo from the rule, a rule edit between apply and
compensate produces a wrong reversal. `rule_version` does not cover a factor
that read live engagement data. Medusa captures the undo payload at apply time
(`new StepResponse(output, compensateInput)`); Vendure's `onDeactivate` receives
the *same inputs* as `onActivate` and must re-derive — which is the weaker
design and the reason this column exists.

### 8.5 `reward_cap_counters` — this index IS the frequency cap

| Column | Type | Note |
| ------ | ---- | ---- |
| id | BIGSERIAL | PK — surrogate, like `customer_engagements` |
| enterprise_id, program_id, rule_id, customer_id | BIGINT | |
| period_key | TEXT | `'LIFETIME'` / `'2026-10-19'` / `'2026-W42'` / `'2026-10'` / `'2026'` |
| used | INTEGER | |
| cap | INTEGER | snapshotted at first claim |

```sql
UNIQUE (enterprise_id, rule_id, customer_id, period_key)
```

**No `is_deleted`, no `ref_id`.** A cap row is a fact about a period —
soft-deleting it hands out a free slot. Nothing addresses it from outside; it is
read through the award that consumed it. The unique index therefore carries **no
predicate**, same category as an idempotency key: it must collide even against a
row someone tried to retire.

### 8.6 `reward_awards`

| Column | Type | Note |
| ------ | ---- | ---- |
| id, enterprise_id, program_id, rule_id | BIGINT | |
| ref_id | UUID | UNIQUE NOT NULL — what support quotes back |
| rule_version | INTEGER | which version decided this |
| customer_id, channel_id | BIGINT | composite FK |
| source_ref_kind | VARCHAR(20) | `message` / `post` |
| source_ref_id | BIGINT | |
| status | VARCHAR(24) | `AwardStatus` |
| factor_inputs | JSONB | **what the factor READ.** Without it "why 0.7?" is unanswerable forever (§7) |
| factor_basis_points | INTEGER | `0..10000`, post-clamp. NULL for `fixed` |
| factor_provider_code | VARCHAR(40) | |
| factor_computed_at | TIMESTAMPTZ | |
| period_key | TEXT | **which slot it consumed** = the "why not?" answer |
| held_until / granted_at / reversed_at | TIMESTAMPTZ | |
| reason_code | VARCHAR(40) | |

```sql
UNIQUE (enterprise_id, rule_id, customer_id, source_ref_kind, source_ref_id)
       WHERE is_deleted = false
INDEX  (enterprise_id, held_until) WHERE status = 'held'
INDEX  (enterprise_id, customer_id, created_at DESC)
```

### 8.7 `reward_wallets`

| Column | Type | Note |
| ------ | ---- | ---- |
| id, enterprise_id | BIGINT | |
| ref_id | UUID | UNIQUE NOT NULL |
| account_kind | VARCHAR(20) | `AccountKind` |
| customer_id | BIGINT | **NULL for house accounts** |
| destination_id | BIGINT | set for transit/external |
| wallet_kind | VARCHAR(16) | decides how `balance` reads |
| currency_code | CHAR(3) | NULL for points, ISO 4217 otherwise |
| balance | BIGINT | **projection, not the record** |
| pending_balance | BIGINT | held, not spendable |
| lifetime_earned | BIGINT | never decremented |
| version | BIGINT | |

```sql
CHECK ((account_kind = 'customer') = (customer_id IS NOT NULL))
CHECK ((account_kind IN ('system_transit','system_external')) = (destination_id IS NOT NULL))

UNIQUE (enterprise_id, customer_id, wallet_kind, COALESCE(currency_code,'---'))
       WHERE account_kind = 'customer' AND is_deleted = false
UNIQUE (enterprise_id, destination_id, account_kind, wallet_kind,
        COALESCE(currency_code,'---'))
       WHERE account_kind <> 'customer' AND is_deleted = false
```

`COALESCE` because NULL currency would otherwise defeat uniqueness — two points
wallets could coexist.

### 8.8 `reward_ledger_entries` — the record

| Column | Type | Note |
| ------ | ---- | ---- |
| id, enterprise_id, wallet_id | BIGINT | |
| ref_id | UUID | UNIQUE NOT NULL — a reversal or dispute names a specific entry |
| entry_kind | VARCHAR(20) | `RewardEntryKind` |
| amount | BIGINT | **signed.** Whole points OR minor units — wallet kind decides |
| balance_after | BIGINT | audit |
| award_id | BIGINT | provenance |
| rule_id, rule_version | | **which rule caused this** |
| group_ref | UUID | pairs convert/forward legs |
| reverses_entry_id | BIGINT | |
| idempotency_key | TEXT | |
| actor_kind / actor_id | | for `adjust` — who |
| occurred_at_utc | TIMESTAMPTZ | business time |
| recorded_at_utc | TIMESTAMPTZ | system time |

```sql
UNIQUE (enterprise_id, idempotency_key)
UNIQUE (enterprise_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL
INDEX  (enterprise_id, wallet_id, id DESC)
```

**No `is_deleted`.** Append-only has no delete. Offering the column invites use.
Enforced by a `BEFORE UPDATE OR DELETE` trigger + no UPDATE path in the repo.

### 8.9 `reward_rule_conditions` — extra predicates on a rule

A trigger says *what happened*. A condition says *whether it qualifies*. Flat
**AND** list, no boolean tree (§6 — Vendure chose this deliberately; Saleor chose
the tree and had to build a Celery materialisation pipeline to stay fast).

| Column | Type | Note |
| ------ | ---- | ---- |
| id, ref_id | | |
| enterprise_id, rule_id | BIGINT | NOT NULL, composite FK |
| rule_version | INTEGER | conditions belong to a rule *version* |
| condition_index | SMALLINT | evaluation order; cheap predicates first |
| condition_kind | VARCHAR(32) | `RewardConditionKind`. Plain VARCHAR — adding one is a code change |
| condition_schema_version | SMALLINT | NOT NULL DEFAULT 1 |
| config | JSONB | the kind's payload. Zod-validated on write and read |

```sql
UNIQUE (enterprise_id, rule_id, rule_version, condition_index)
INDEX  (enterprise_id, rule_id, rule_version) WHERE is_deleted = false
```

Same shape as `reward_rule_benefits` (§8.3) on purpose — **one descriptor, three
registries** (triggers, conditions, benefits). The second registry costs almost
nothing once the first exists, and every improvement to the form engine lands on
all three.

#### Why the weekly schedule is a condition, not a table

`reward_schedule_windows` used to be its own table with ~20 lines of bespoke SQL
in the evaluation path. It was the wrong shape: **"is this inside the window?" is
a predicate on the event, exactly like "does this comment contain a keyword."**

The test is *what varies*:

| | Scope | Modelled as |
| --- | --- | --- |
| `starts_at` / `ends_at` | one per **program** — the campaign period | **columns on the program** (§8.1). Lifecycle, queried, shown in the UI |
| Day / time windows | can vary **per rule** — "double points Tuesdays 6–9pm, normal points always" | **a condition** |

The old design could not express that second row at all: "double points on
Tuesdays" needed a whole second program, with its own budget and its own caps,
for what is one campaign with two rules.

```ts
export enum RewardConditionKind {
  TimeWindow      = 'time_window',       // day-of-week + local clock window
  CustomerTenure  = 'customer_tenure',   // "must have engaged before today" — §18
  ContentMatch    = 'content_match',     // keyword in the comment or caption
}
```

Three to start. The registry makes the fourth cheap later; building it now is the
mistake the catalogue evidence warns about (§17).

**`time_window` config**, carrying the same semantics the table had:

```jsonc
{ "slots": [
    { "days": [2, 4], "start": "12:00", "end": "14:00" },   // lunch
    { "days": [2, 4], "start": "18:00", "end": "21:00" },   // dinner
    { "days": [5],    "start": "22:00", "end": "02:00" }    // wraps past midnight
  ] }
// days: ISO 1=Mon … 7=Sun, matching EXTRACT(ISODOW)
// start/end: LOCAL WALL CLOCK, resolved in the program timezone
// start > end means the slot wraps into the next day
```

**Slots are a list, and they OR.** One day can have several — lunch *and*
dinner is the obvious case, and a single start/end pair could not express it.
Within one `time_window` condition the slots are ORed; conditions themselves AND
at the rule level (§8.9). That is the only place an OR exists in the whole
design, and it is contained inside one handler rather than being a general
boolean tree.

**Still `TIME`-like, never an offset.** A recurring window is a wall-clock fact —
6pm Tuesday means 6pm local in March and in November. Store an offset and DST
shifts every window twice a year. The program's `timezone` resolves it, the same
column that resolves `period_key`.

**Empty condition list means "always".** The absence of conditions must not mean
"never" — that would silently disable every rule nobody configured. One of the
five defects found in the coupon engine we examined was exactly this: rows stored
with empty condition *and* action groups, with nothing to say what they meant.


### 8.10 The rest

```sql
reward_entitlements(
  id, ref_id, enterprise_id, customer_id, award_id, item_ref,
  status, redemption_code, issued_at, expires_at, reserved_until, redeemed_at)
UNIQUE (enterprise_id, redemption_code) WHERE is_deleted = false
-- redemption_code is NOT ref_id: ref_id is the API handle, the code is what a
-- customer reads out at a till. Short and typeable vs long and opaque.
```

**Three tables I removed, and why.** Each was machinery this repo already has.

| Removed | Replaced by |
| ------- | ----------- |
| `reward_conversion_rules` | a **rule** — see below |
| `reward_destinations` | two columns on `reward_programs`: `forward_provider_code`, `forward_config JSONB` |
| `reward_forward_outbox` | **`outbound_events`** — see §13.3 |

#### Conversion is a rule, not a mechanism

"When points reach 30, burn 30 and grant ₹50" is a **trigger plus a benefit**.
Building it separately duplicated caps, budget, versioning, audit and the award
state machine — all of which rules already have.

```ts
RewardTriggerKind.PointsBalanceReached = 'points_balance_reached'   // internal event
RewardBenefitKind.ConvertValue          = 'convert_value'            // already existed
```

An internal event is still an event — Open Loyalty models exactly this as
`AvailablePointsAmountChangedSystemEvent`. The payoff is immediate: *"convert at
most once a day"* becomes a `cap_scope`, which the separate mechanism could not
express at all, and the `mode: AUTO | ON_REQUEST` enum disappears because a rule
is already either automatic or not.

## 9. Is the program running?

Four independent questions. **All must pass.** Collapsing any two of them into
one column is how "my campaign didn't fire" becomes unanswerable.

```
   1. SWITCH      status = 'active'                 the enterprise turned it on
   2. DATE RANGE  starts_at <= T < ends_at          the campaign period
   3. RULE        rule is_active                    this rule in particular
   4. CONDITIONS  every condition passes (AND)      incl. time_window (§8.9)

                         ALL FOUR → award.  ANY ONE FALSE → no award.
```

| State | `status` | In date range | Conditions pass |
| ----- | -------- | ------------- | --------- |
| Being written | `draft` | — | — |
| **Scheduled for next month** | **`active`** | **no, future** | — |
| Running, Tuesday 7pm | `active` | yes | yes |
| Running, Tuesday 11pm | `active` | yes | **no — `time_window` fails** |
| Campaign finished | `active` | **no, past** | — |
| Switched off mid-campaign | `paused` | yes | yes |

**`status = 'active'` does not mean "awarding right now".** It means the
enterprise has switched it on. A program scheduled for next month sits `active`
with a future `starts_at` — there is no `scheduled` status, because the date
already says it.

Likewise **no `ended` status**: `ends_at` in the past says it. Two columns
answering one question is exactly the duplication `schema.md` rejects when it
forbids `deleted` inside any `status` enum.

### 9.1 `T` is the event time, not now

> **The window is evaluated against `occurred_at` — when the customer acted —
> never against `recorded_at` or `now()`.**

A webhook that arrives four minutes late, a backfill replayed the next morning,
a queue that backed up: all of them would push a legitimate action outside the
window if we judged by arrival. The customer commented at 20:58 on Tuesday. That
is the fact. When we found out is our problem, not theirs.

This is what the bitemporal pair on the ledger (§8.6) exists for, and the reason
`occurred_at_utc` is populated from the platform timestamp rather than the
insert.

### 9.2 Checked at event time, not grant time

The window decides **"was the program running when they acted"** — so it is
evaluated when the award row is created, not when the hold expires.

The factor is the opposite (§7): evaluated at grant time, because it asks a
question about how the content performed. Two different questions, two different
clocks. Worth being explicit, because they run in the same pipeline and the
temptation is to do both in one place.

### 9.3 Evaluation

Gates 1–3 are SQL — they narrow which rules are worth loading. Gate 3 has a
**second half** in TypeScript (the trigger *config*, §8.2.1: SQL matched the
kind, this matches what the business narrowed it to), judged before the
transaction opens. Gate 4 runs in the condition registry against the loaded
rule.

```sql
-- gates 1-3: which rules could possibly apply to this event
SELECT r.*
  FROM reward_rules r
  JOIN reward_programs p
    ON p.id = r.program_id AND p.enterprise_id = r.enterprise_id
 WHERE r.enterprise_id = :ent
   AND r.trigger_kind  = :trigger
   AND r.is_active AND NOT r.is_deleted
   AND p.status = 'active'
   AND (p.starts_at IS NULL OR :occurred_at >= p.starts_at)
   AND (p.ends_at   IS NULL OR :occurred_at <  p.ends_at)
 ORDER BY r.priority, r.id;        -- deterministic
```

```ts
// gate 3b: the rule's own narrowing — pure, no database
if (!matchesTriggerConfig(parse(rule.triggerConfig), event)) continue;

// gate 4: flat AND over the rule's conditions
for (const condition of rule.conditions) {          // ordered, cheap ones first
  const handler = CONDITION_HANDLERS[condition.kind];   // Record<Kind, Handler> — total
  if (!handler) return skip('unknown_condition');       // FAIL CLOSED (§14.5)
  if (!(await handler.check(condition.config, event, ctx))) {
    return skip(`condition_failed:${condition.kind}`);  // names WHICH one
  }
}
```

**The bespoke window SQL is gone.** It was ~20 lines of `EXTRACT(ISODOW)` and
wrap-around time comparison inlined in the claim query. `time_window` is now one
condition handler, unit-testable without a database, and the DST reasoning lives
in one function instead of a correlated subquery.

**Cheap enough.** A handful of rules per enterprise per trigger, and conditions
are pure functions over an already-loaded event.


### 9.4 Record which gate failed

An award that does not happen is still worth a row when the enterprise will ask
about it. `AwardStatus` gets one more terminal value:

```ts
SkippedCondition = 'skipped_condition',   // reason_code names which (§9.4)
```

With `reason_code` naming **which** gate failed — `program_paused`,
`before_start`, `after_end`, `rule_inactive`, and for gate 4
`condition_failed:<kind>`.

**Naming the failing condition is what keeps the diagnostic.** Folding the
weekly window into the condition list would otherwise have traded a precise
`outside_weekly_window` for a useless "a condition failed". Every condition
handler is required to be nameable in `reason_code`, so *"why didn't Tuesday
11pm count?"* still answers itself: `condition_failed:time_window`.

---

## 10. Uniqueness — three races, three constraints

**Never check-then-write.** Every one of these is a constraint, not a service check.

### 10.1 One event never awards twice

```sql
UNIQUE (enterprise_id, rule_id, customer_id, source_ref_kind, source_ref_id)
```

Redelivered webhook, replayed backfill, retried job → all conflict → return the
existing award.

Sits *below* `inbound_events` dedup, not instead of it. That protects transport.
This protects the grant. One comment can reach the engine via **webhook AND
backfill** — two transport events, one fact.

### 10.2 Frequency cap — atomic, one statement

```sql
INSERT INTO reward_cap_counters
       (enterprise_id, program_id, rule_id, customer_id, period_key, used, cap)
VALUES ($1, $2, $3, $4, $5, 1, $6)
ON CONFLICT (enterprise_id, rule_id, customer_id, period_key)
DO UPDATE SET used = reward_cap_counters.used + 1
        WHERE reward_cap_counters.used < reward_cap_counters.cap
RETURNING used;
```

**0 rows = capped.** No window, because there is no separate check. Handles
"once ever" and "3 per week" identically.

`period_key` resolved in the **enterprise timezone**. A Mumbai café's "once a
day" must not reset at 05:30 local.

> **Rejected: `SELECT ... FOR UPDATE` then count.** Locks only rows that already
> match. Does not stop a concurrent INSERT. This exact flaw shipped in the
> published Sylius patch (CVE-2026-31824, CVSS 8.2) — and the original bug was
> an ORM flushing `SET used = 1` instead of an increment, so concurrent writers
> overwrote each other.

### 10.3 Program budget

```sql
UPDATE reward_programs
   SET spent_minor = spent_minor + :cost
 WHERE id = :id AND enterprise_id = :ent
   AND (budget_minor IS NULL OR spent_minor + :cost <= budget_minor)
RETURNING spent_minor;
```

0 rows → `skipped_budget`. Points and items carry `budget_cost_minor` or the
budget guards nothing but currency.

### 10.4 Transaction order

```
1. INSERT award  ON CONFLICT DO NOTHING  → no row? already processed. EXIT
2. claim cap counter                     → 0 rows? state=skipped_cap.     COMMIT
3. claim program budget                  → 0 rows? state=skipped_budget.  COMMIT
4. evaluate factor, snapshot it          → 0 factor? release cap. COMMIT
5. write ledger entries + wallet projection
6. enqueue forward if configured
   COMMIT
```

Skipped awards are **recorded, not discarded.** "Why didn't I get my points?" is
answered by one row: `skipped_cap` + `period_key`.

---

## 11. Wallets — points and money, side by side

One customer holds **points AND one or more currencies at once.** Normal case.

```
customer 8812 ──┬── POINTS              balance    340
                ├── CURRENCY  INR       balance  25000   = ₹250.00
                └── CURRENCY  USD       balance   1200   = $12.00
```

| Kind | `amount` means | Scale |
| ---- | -------------- | ----- |
| `points` | **whole points** | none. 340 is 340, never 3.40 |
| `currency` | **minor units** | 25000 + `INR` = ₹250.00 |

Both `BIGINT`. Never a float.

**Three invariants:**

1. **Never net across wallets.** There is no "total balance". Any screen, API or
   export collapsing them is wrong.
2. **Minor-unit scale comes from ISO 4217, never a constant.** JPY/KRW/VND = 0,
   INR/USD = 2, KWD/BHD = 3. Hardcoded ×100 is silently wrong for a lot of the
   world.
3. **No implicit FX.** Nothing converts currency to currency. Ever.

---

## 12. Award lifecycle

```
                    ┌──────── cap taken ────────▶ SKIPPED_CAP      (terminal)
                    │
                    ├──────── no budget ────────▶ SKIPPED_BUDGET   (terminal)
   event ──▶ award ─┤
                    ├──── factor = 0 ───────────▶ SKIPPED_ZERO_FACTOR
                    │                             └─ releases the cap slot
                    │
                    └──▶ HELD ──── hold_hours ──▶ GRANTED ──▶ ledger + wallet
                           │                         │
                           │ content deleted/hidden  │ content deleted/hidden
                           ▼                         ▼
                        EXPIRED                   REVERSED
                       (no ledger)            (reversal entry, cap released,
                                               balance may go negative)
```

**Hold does two jobs:** reversal window, and settling time for the factor.

**Expiry ≠ deletion.** A story vanishing at 24h is the story working. A story
deleted at hour 3 is the signal. Conflating them claws back from every honest
customer. Only explicit delete/hide (`remove`/`hide` verbs, §6.5) reverses.

**Compensation idempotency — two rules, not one.** Re-submitting the **same**
compensation id is a success no-op (retry safety). Issuing a **different**
compensation against an already-reversed award is an **error** — that is a logic
bug and swallowing it hides double-reversal. TigerBeetle, a purpose-built
ledger, returns an error rather than a no-op for exactly this reason. Our
`UNIQUE (enterprise_id, idempotency_key)` gives the first rule and
`UNIQUE (enterprise_id, reverses_entry_id)` the second.

**Balances may go negative.** Deliberate, not a crash:

- Negative takes effect immediately and **never expires** (one that could expire
  is an exploit)
- **Rule evaluation can never go below zero.** Only reversals and `adjust` can
- Offset automatically by the next earn, same transaction

---

## 13. Forwarding — a transfer, not a side benefit

**The value LEAVES us.** The customer's balance must drop, or the same 20 points
exist in two places and get spent twice.

```
 t0  award grants          EARN         +20 ──▶ customer wallet        = 20
 t1  forward enqueued      FORWARD_OUT  -20 ──▶ customer wallet        =  0
                           TRANSIT_IN   +20 ──▶ transit(dest X)        = 20
 t2a provider ACKs         TRANSIT_OUT  -20 ──▶ transit(dest X)        =  0
                           EXTERNAL_OUT +20 ──▶ external(dest X)       = 20  (cumulative)
 t2b permanently DEAD      TRANSIT_OUT  -20 ──▶ transit(dest X)        =  0
                           FORWARD_BACK +20 ──▶ customer wallet        = 20
```

**Why the transit leg.** Without it, an enqueued-but-unacked forward has value
debited from the customer and confirmed nowhere. With it, **a stuck forward is a
non-zero balance someone sees**, not a report nobody runs. Same instinct as the
dead-letter gauge already in this codebase.

> **Invariant: `transit` drains to ~0 on the expected cadence.** A persistently
> non-zero transit balance means forwarding has quietly stopped. Alarm on it.

`external(dest X)` grows forever — the cumulative record of what we handed over.
Reconcilable against whatever report the destination produces.

### 13.1 It goes through `outbound_events`, not a new table

A reward forward is **one value in an existing enum**, not an outbox of its own:

```ts
OutboundEventType.RewardForward = 'reward_forward'
```

`outbound_events` already carries everything the forward needs —
`destination_kind` (which already includes **`webhook`**), `destination_id`,
`payload`, the full `pending → scheduled → leased → sending → sent → failed →
dead_letter` status machine, `platform_event_id` for the remote id, lease
columns, `attempt_count`, jittered backoff and dead-lettering.

And the precedent is already in the repo: `OutboundEventType.VerificationSend`
is *"verification code delivery, through the same transactional outbox."* A
non-Meta concern reusing this table is established practice, not a stretch.

**What a second outbox would have cost:** a table, a poller, lease columns
duplicated, a line in `LeaseReaperWorker`, a queue in `QueueGaugeWorker`, and a
second copy of the backoff curve to keep in sync with the first. All of it for
behaviour that already exists and is already exercised in production.

One addition: `sent_stub` joins the status enum (§13.2). It is app-validated,
so that is a code change, not a migration.

### 13.2 `noop` must not move value

```ts
interface ForwardingProvider {
  readonly code: string;
  forward(entry: LedgerEntry, config: DestinationConfig): Promise<ForwardResult>;
}
```

V1 registers one: **`constant_one`'s sibling, `noop`** — no I/O, reports success.

**With `noop`, NOTHING moves in the ledger.** No `FORWARD_OUT`. Value stays
spendable in Wouchh.

If the stub "succeeded" and we wrote `FORWARD_OUT`, the customer's balance would
drop to zero and the value would be **nowhere**. Actively destructive, and worse
than not forwarding at all.

| Rule | Why |
| ---- | --- |
| Terminal state is `sent_stub`, **not** `sent` | Or it is indistinguishable from a real send, forever |
| `provider_code` stored **per row** | The destination's provider changes; history must not re-label itself |
| `external_ref` stays NULL | No remote id exists. Inventing one is fabricating a receipt |
| Switching `noop` → real does **not** backfill | Replaying the `sent_stub` backlog is an explicit decision with double-grant risk on the far side |

### 13.3 Destination must be the same enterprise

Forwarding to the **enterprise's own** system = same issuer, different ledger =
still closed loop.

Forwarding to a **third party** = third-party settlement = outside the closed
loop = RBI PPI territory (§15).

```sql
-- enforced, not assumed
CHECK: the forward destination configured on a program is that program's
-- own. A forward to a THIRD PARTY is third-party settlement (§15).
```

---

## 14. Dispatch — one applier, one compensator

The architecture that makes adding an benefit kind cheap. The measured target is
**1 file + 1 line + tests**; the median across seven real commits in five OSS
systems is 7 files, 1 of them logic.

### 14.1 One payload map is the source of truth

Do not hand-write the union and the registry separately. Write one map, derive
both.

```ts
export interface BenefitPayloads {
  grant_points:      { points: number };
  grant_currency:    { minorUnits: number; currencyCode: string };
  issue_entitlement: { itemRef: string };
  convert_value:     { fromWallet: WalletKind; times: number };
}
export type BenefitKind = keyof BenefitPayloads;
export type BenefitHandlerMap = { readonly [K in BenefitKind]: BenefitHandler<K> };
```

Omit a handler and the compiler raises **TS1360, naming the missing kind.** File
one under the wrong key and TS2322 says which. That is the whole mechanism — the
registry is not an abstraction, it is a table with a completeness check.

A dispatcher written the obvious way does **not** compile (`map[e.kind].apply(e)`
intersects every parameter type down to `never`). Making it generic over the
discriminant fixes it with no cast.

### 14.2 The compensator is in the type, not the docs

Two thirds of a mature loyalty engine is irreversible — Talon.One ships 42
benefits, 8 rollbacks covering 12 forwards, 22 with none. So reversibility is a
declared property:

```ts
type Compensable<K> = Base<K> & {
  reversibility: Reversibility.Compensable;
  compensate(applied: AppliedBenefit, ctx: BenefitContext): Promise<void>;   // REQUIRED
};
type Pivot<K> = Base<K> & {
  reversibility: Reversibility.Pivot;
  irreversibleBecause: string;      // forced into code review, not a wiki
  compensate?: never;               // cannot be half-written
};
export type BenefitHandler<K> = Compensable<K> | Pivot<K>;
```

**Nobody in the field enforces this.** Vendure's `onActivate`/`onDeactivate` are
both optional; Medusa records a missing compensator as a boolean flag. The
convention of forcing a written reason for a gap in a total registry already
exists in this repo — `conversation-permissions.ts`.

### 14.3 Validate at the boundary, in a pipeline, not per handler

```ts
const PIPELINE: readonly BenefitMiddleware[] = [
  withStructuredLogging,   // awardRefId, ruleId, ruleVersion, benefitKind
  withMetrics,
  withTenantAssertion,     // benefit.enterpriseId === ctx.enterpriseId, always
  withIdempotency,         // INSERT ... ON CONFLICT DO NOTHING
];
```

Order is load-bearing: tenant assertion **inside** logging so a violation is
logged, **outside** idempotency so a cross-tenant replay is not swallowed as a
duplicate. Medusa, lacking this, hand-rolls a SELECT-then-INSERT idempotency
check inside a first-party step — a race, in a framework whose selling point is
durable steps.

### 14.4 Three validation layers, each doing a different job

`config` is JSONB, so the type system stops at the boundary. One layer is not
enough, and the reason is specific:

| Layer | Mechanism | Catches |
| ----- | --------- | ------- |
| **Write** | Zod `discriminatedUnion` + `strictObject` in the repository | Bad payloads entering. **The layer nobody in the field implements** |
| **Read** | `schema.parse` when loading a rule benefit; fail loudly | Rows written before a schema change |
| **CI** | `safeParse` every stored payload, assert zero failures | **Rows already wrong.** The only layer that would have caught the 58 |

> **A constraint is a gate, never an audit.** Postgres assumes `CHECK`
> conditions are immutable — change a function a `CHECK` calls and
> `VALIDATE CONSTRAINT` reports success while rows violate it. Documented
> behaviour, reproduced on our own 17.5. Prevention and detection are different
> jobs and need different mechanisms.

### 14.5 Fail closed, and validate the registry at boot

An unknown `benefit_kind` or `trigger_kind` — a rule referencing something
removed, or not yet deployed — **awards nothing**. Vendure's
`if (!promotionCondition) return false;`.

This matters more for us than for them: a mis-resolved rule here **grants
value**, where theirs merely withholds a discount.

And assert the registry at startup, not at dispatch. Keycloak discovers an
unregistered authenticator as a `RuntimeException` **on a live user's login** —
its error string literally asks *"did you forget to declare it in a
META-INF/services file?"* Never discover a missing applier when a customer earns
points.

### 14.6 All-or-nothing, and it is free here

Talon.One: *"If one benefit cannot be applied, all the other benefits in the same
rule will also not be applied"* — and benefits are ordered, because a later one
sees the budget an earlier one consumed.

`RequestContext.runInTransaction` gives us this with **zero plumbing**:
repositories resolve the ambient transaction per call, so N heterogeneous
appliers commit or none do. No saga, no orchestrator, no engine.

**If any benefit fails, the cap slot is released too** — `GREATEST(used - 1, 0)`.
The award did not happen, so the slot was not consumed.

The one benefit that cannot join the transaction is the external forward. That is
what the outbox is for (§13).

### 14.7 What we are deliberately not building

Temporal, Restate, Inngest, DBOS, `@nestjs/cqrs`, or any saga orchestrator.

The honest objection is that §14 plus the outbox **is** a workflow engine —
step table, idempotency keys, compensation payloads, middleware, leases,
backoff, dead-lettering. DBOS ships exactly that, tested, for $99/month.

The reason we still don't: **our checkpoint and our ledger are the same record.**
An append-only double-entry ledger with reversing entries already replays and
audits, and a non-zero transit balance is a stuck-workflow alarm no engine would
give us. Adopting one creates a **second source of truth about money** that can
disagree with the first — worse, for a closed-loop system under RBI scrutiny,
than any bug it would prevent.

Revisit if dispatch spans services, or human-in-the-loop waits run to days, or
recovery across instances becomes a pager source.

---

## 15. Closed loop, enforced by absence

Money model: **enterprise owes the customer, redeemable only with that
enterprise.** Outside RBI PPI. All four must hold:

1. Redeemable only against the issuing entity's own goods
2. No cash withdrawal
3. No transfer to a bank account or another user
4. Never settles an obligation owed to anyone else

Break one → Certificate of Authorisation → ₹5 crore net worth + bank escrow +
quarterly auditor certification.

**EBA standard: technical AND contractual restrictions, cumulatively.** The
system must be *incapable*, not merely forbidden.

**So these do not exist, and a test asserts each path is absent:**

| Not built | |
| --------- | - |
| Cash-out endpoint | no path converts a balance to a payout |
| Customer→customer transfer | no entry type moves value between two `customer_id`s |
| Cross-enterprise wallet | `enterprise_id` leads every key |
| Third-party settlement | §13.2 |

**Wouchh holds no float.** We record what the enterprise owes. The alternative
pulls escrow, daily reconciliation as a compliance obligation, and an RBI
conversation into scope.

---

## 16. A real program, as rows

Acme Coffee. Instagram `@acmecoffee`. Five rules. Every row below is what the
DB actually holds.

### 16.1 The program

```
reward_programs
┌────┬─────┬────────────────┬────────┬───────────────┬──────────────┬─────────────┐
│ id │ ent │ name           │ status │ timezone      │ budget_minor │ forward_    │
│    │     │                │        │               │ (INR)        │ provider    │
├────┼─────┼────────────────┼────────┼───────────────┼──────────────┼─────────────┤
│ 50 │  1  │ Social Rewards │ active │ Asia/Kolkata  │   5 000 000  │ NULL        │
└────┴─────┴────────────────┴────────┴───────────────┴──────────────┴─────────────┘
  starts_at = 2026-11-01 00:00 IST     ends_at = 2027-02-01 00:00 IST
  budget_minor 5 000 000 = ₹50,000     forward_provider NULL = value stays here
```

### 16.2 Five rules

```
reward_rules
┌────┬─────┬─────┬──────────────────────────────┬──────┬───────────┬──────┬────────┐
│ id │ ver │ pgm │ trigger_kind                 │ caps │ cap_scope │ hold │ revers │
├────┼─────┼─────┼──────────────────────────────┼──────┼───────────┼──────┼────────┤
│ 71 │  1  │ 50  │ story_mention                │  1   │ week      │ 24h  │ on_del │
│ 72 │  1  │ 50  │ comment_on_own_post          │  1   │ day       │  0   │ on_del │
│ 73 │  1  │ 50  │ comment_on_own_post          │  1   │ day       │  0   │ on_del │
│ 74 │  1  │ 50  │ referral_entry               │  1   │ lifetime  │  0   │ none   │
│ 75 │  1  │ 50  │ points_balance_reached       │  —   │ none      │  0   │ none   │
└────┴─────┴─────┴──────────────────────────────┴──────┴───────────┴──────┴────────┘
     71 = story about us          74 = scanned the in-store QR
     72 = any comment             75 = CONVERSION. A rule, not a mechanism (§8.10)
     73 = happy-hour comment bonus
```

### 16.3 Rule 73 is the happy hour. Conditions do that.

```
reward_rule_conditions
┌─────┬──────┬─────┬───────┬────────────────┬──────────────────────────────────────┐
│ id  │ rule │ ver │ index │ condition_kind │ config                                │
├─────┼──────┼─────┼───────┼────────────────┼──────────────────────────────────────┤
│ 310 │  73  │  1  │   0   │ time_window    │ {"slots":[                            │
│     │      │     │       │                │   {"days":[2,4],"start":"15:00",      │
│     │      │     │       │                │    "end":"17:00"}]}                   │
└─────┴──────┴─────┴───────┴────────────────┴──────────────────────────────────────┘
```

Rules 71/72/74/75 have **no condition rows at all**. Empty list = always (§8.9).

Rule 72 and 73 both fire on a 4pm Tuesday comment. Both grant. **That is
correct** — 5 base points plus 10 bonus. Caps are per rule, so each keeps its
own slot.

### 16.4 What each rule awards

```
reward_rule_benefits
┌─────┬──────┬───────┬───────────────────┬────────────┬─────┬────────┬──────────────────────┐
│ id  │ rule │ index │ benefit_kind       │ award_mode │ cap │ budget │ config               │
│     │      │       │                   │            │     │ _minor │                      │
├─────┼──────┼───────┼───────────────────┼────────────┼─────┼────────┼──────────────────────┤
│ 901 │  71  │   0   │ grant_points      │ up_to      │ 20  │  200   │ {}                   │
│ 902 │  72  │   0   │ grant_points      │ fixed      │  —  │   50   │ {"points":5}         │
│ 903 │  73  │   0   │ grant_points      │ fixed      │  —  │  100   │ {"points":10}        │
│ 904 │  74  │   0   │ grant_points      │ fixed      │  —  │  500   │ {"points":50}        │
│ 905 │  74  │   1   │ issue_entitlement │ fixed      │  —  │ 15000  │ {"itemRef":"COFFEE"} │
│ 906 │  75  │   0   │ convert_value     │ fixed      │  —  │    0   │ {"burnPoints":30,    │
│     │      │       │                   │            │     │        │  "grantMinor":5000,  │
│     │      │       │                   │            │     │        │  "currency":"INR"}   │
└─────┴──────┴───────┴───────────────────┴────────────┴─────┴────────┴──────────────────────┘
```

**Rule 74 has two benefits.** 50 points AND a free coffee. One award, applied
all-or-nothing. This is the case the old one-benefit-per-rule schema could not
represent.

**Only 901 is `up_to`.** The factor scales points. It cannot scale a coffee
(§8.3), so 905 is `fixed` and the registry refuses to make it otherwise.

**Budget cost is per benefit.** Rule 74 claims 500 + 15 000 = **₹155.00** against
the program budget. Adding a third benefit raises that automatically.

---

### 16.5 Priya scans the QR — Mon 10 Nov, 09:14 IST

`messaging_referrals` webhook → `referral_entry` → rule 74.

```
reward_cap_counters                         reward_awards
┌─────┬──────┬──────┬──────────┬──────┐    ┌──────┬──────┬─────┬────────┬────────────┐
│ ent │ rule │ cust │ period   │ used │    │  id  │ rule │cust │ status │ period_key │
├─────┼──────┼──────┼──────────┼──────┤    ├──────┼──────┼─────┼────────┼────────────┤
│  1  │  74  │ 8812 │ LIFETIME │  1   │    │ 3301 │  74  │8812 │granted │ LIFETIME   │
└─────┴──────┴──────┴──────────┴──────┘    └──────┴──────┴─────┴────────┴────────────┘
  programs.spent_minor: 0 → 15 500
```

Two benefits, one transaction:

```
reward_award_benefits
┌──────┬───────┬───────┬───────────────────┬─────────┬──────────────────────────┐
│  id  │ award │ index │ benefit_kind       │ status  │ compensation             │
├──────┼───────┼───────┼───────────────────┼─────────┼──────────────────────────┤
│ 5501 │ 3301  │   0   │ grant_points      │ applied │ {"entryId":7701}         │
│ 5502 │ 3301  │   1   │ issue_entitlement │ applied │ {"entitlementId":4401}   │
└──────┴───────┴───────┴───────────────────┴─────────┴──────────────────────────┘

reward_ledger_entries              reward_entitlements
┌──────┬────────┬──────┬────────┐  ┌──────┬──────┬──────────┬────────┬──────────┐
│  id  │ wallet │ kind │ amount │  │  id  │ cust │ item_ref │ status │ code     │
├──────┼────────┼──────┼────────┤  ├──────┼──────┼──────────┼────────┼──────────┤
│ 7701 │  4410  │ earn │   +50  │  │ 4401 │ 8812 │ COFFEE   │ issued │ 7K2M-QX9 │
└──────┴────────┴──────┴────────┘  └──────┴──────┴──────────┴────────┴──────────┘
```

`compensation` holds what the applier **produced** — entry 7701, entitlement
4401. The compensator reverses *those*, never recomputes from the rule (§8.4).

### 16.6 Priya posts a story — Tue 11 Nov, 14:02 IST

Rule 71. `hold_hours = 24`, so the award parks.

```
reward_awards
│ 3307 │ 71 │ 8812 │ held │ 2026-W46 │   held_until = 12 Nov 14:02 IST
```

**No points yet. No ledger row.** The factor has not run.

She posts a **second** story at 16:40. The counter INSERT returns 0 rows —
`used(1) < cap(1)` is false.

```
│ 3309 │ 71 │ 8812 │ skipped_cap │ 2026-W46 │   reason_code = cap_consumed
```

Recorded, not discarded. That row is the answer when she asks.

### 16.7 Hold expires — Wed 12 Nov, 14:02 IST

`constant_one` → `factor_basis_points = 10000` → `(20 × 10000 + 5000)/10000` = **20**.

```
reward_awards 3307   status = granted   factor_basis_points = 10000
                     factor_provider_code = 'constant_one'
                     factor_inputs = {}        ← empty now. NOT NULL later (§7)

reward_ledger_entries
│ 7740 │ 4410 │ earn │ +20 │ balance_after 70 │ award 3307 │ rule 71 v1 │
                              occurred_at = 11 Nov 14:02   ← when SHE posted
                              recorded_at = 12 Nov 14:02   ← when we granted
```

Bitemporal. The window and the cap were judged against `occurred_at` (§9.1).

### 16.8 Balance hits 70 → the conversion rule fires

Rule 75, trigger `points_balance_reached`, `trigger_config = {"minPointsBalance": 30}`.
`floor(70 / 30) = 2`.

**What raises it.** Every credit that moves a points balance — Priya's comment
above — offers the new balance back to the threshold rules, *after* its
transaction commits. The source ref is the **award that credited**, so the
exactly-once index deduplicates for free: one threshold award per crediting
award per rule, however many times the job is retried, while her next crossing
arrives under its own award and is judged afresh.

Three properties this buys, none of them free if the offer were made inside the
grant's transaction:

| | |
| --- | --- |
| after the commit | nesting *joins* the ambient transaction with no savepoint — a threshold rule that threw would poison the grant that earned the points |
| held awards too | a 24h hold credits hours later; the deferred granter makes the same offer |
| never recursive | a threshold rule cannot fire another. Nothing grants points from a crossing today, but the day somebody writes that rule it is an unbounded loop spending a real budget |

```
reward_ledger_entries                     group_ref pairs the legs
┌──────┬────────┬──────────────┬────────┬───────────────┬──────────┐
│ 7741 │  4410  │ convert_out  │   -60  │ after:  10    │ g:a91f…  │
│ 7742 │  4411  │ convert_in   │ +10000 │ after: 10000  │ g:a91f…  │
└──────┴────────┴──────────────┴────────┴───────────────┴──────────┘
```

One statement does the burn — `WHERE balance >= 60`. Zero rows would mean
insufficient, and nothing else runs.

### 16.9 Where Priya stands

```
reward_wallets
┌──────┬──────┬──────────────┬──────┬────────────┬──────────┬─────────┬──────────┐
│  id  │ ent  │ account_kind │ cust │ wallet_kind│ currency │ balance │ lifetime │
├──────┼──────┼──────────────┼──────┼────────────┼──────────┼─────────┼──────────┤
│ 4410 │  1   │ customer     │ 8812 │ points     │ NULL     │      10 │    70    │
│ 4411 │  1   │ customer     │ 8812 │ currency   │ INR      │   10000 │    —     │
└──────┴──────┴──────────────┴──────┴────────────┴──────────┴─────────┴──────────┘
```

**10 points and ₹100.00. Two numbers. Never one.** `lifetime_earned` stays 70 —
spending never reduces it, which is what a tier would read if tiers ever arrive.

Plus one unredeemed coffee, code `7K2M-QX9`.

### 16.10 She deletes the story — Thu 13 Nov

`feed` verb `remove` → `removed` → rule 71 says `on_content_deleted`.

```
reward_awards 3307              status = reversed   reason_code = content_removed
reward_award_benefits                  status = compensated
reward_ledger_entries
│ 7755 │ 4410 │ reversal │ -20 │ after: -10 │ reverses_entry_id 7740 │
reward_cap_counters             used 1 → 0        GREATEST(used-1, 0)
```

**Balance goes to −10 and that is correct.** She already converted 60 of those
points to ₹100. The negative is real debt, it never expires, and the next earn
offsets it automatically (§12).

The ₹100 is **not** clawed back. Currency and points are different wallets and
nothing nets across them.


## 17. Audit — who changed the money rules

Every config endpoint is JWT-authenticated and **every write is audited**. A
reward rule decides who gets value. Changing one is a money decision.

### 17.1 Audit the config. Not the awards.

`AuditService.record()` takes the actor from `RequestContext` — *"a caller
cannot record an action under the wrong actor."* No request context, and it
falls back to `ActorKind.System`.

That fallback is the trap. **An award has no human actor.** It is caused by a
rule, from a webhook, in a worker. Audit every award and you get millions of
rows that all say `system`, drowning the handful that name a person.

| Event | Actor | Goes where |
| ----- | ----- | ---------- |
| Create / edit / pause a **program** | human, JWT | **`audit_logs`** |
| Create / edit / disable a **rule**, its benefits, its conditions | human, JWT | **`audit_logs`** |
| Change **budget**, **caps**, **forward destination** | human, JWT | **`audit_logs`** |
| Manual balance **`adjust`** | human, JWT | **both** — §17.3 |
| An **award** granted by a rule | none | ledger provenance only |
| A **reversal** from deleted content | none | ledger provenance only |
| An **benefit** applied or compensated | none | `reward_award_benefits` |

The ledger already carries `award_id`, `rule_id`, `rule_version`, `group_ref`,
`reverses_entry_id` and bitemporal timestamps. **That is the system-caused
trail.** `audit_logs` is the human-caused one. Two tables, one concept each —
the same discipline `schema.md` applies to `status` vs `is_deleted`.

### 17.2 What gets written

```ts
await this.audit.record({
  action:     'updated',                 // created · updated · deleted
  entityType: 'reward_rule',             // + reward_program · reward_wallet
  entityId:   rule.id,
  changes:    { from: { version: 1 }, to: { version: 2 } },
});
```

Actor, `ip_address`, `user_agent` and `correlationId` are filled from context.
The caller does not pass them and cannot forge them.

**Rules are versioned, so the version IS the diff.** `audit_logs` names who and
when; `reward_rules` v1 and v2 hold exactly what changed. No need to duplicate
the rule body into `changes`.

**Never put PII or secrets in `changes`.** A rule config is safe. A
`forward_config` is **not** — it holds a credential reference. Audit the fact
that it changed, never the value.

**Audit failures too.** `status` is `success | failure | error`. A rejected
attempt to raise a budget is worth more than a successful one.

### 17.3 Manual adjustment is the one that needs both

```
audit_logs              who did it, from which IP, under which role
reward_ledger_entries   the money moved — actor_kind + actor_id ON the entry
```

Two records, two jobs. The audit row answers *"who touched this account?"*; the
ledger entry answers *"why is the balance what it is?"* and must stand alone
when Finance reads the ledger without the audit table beside it.

Needs an RBAC permission of its own — §21 Q3.

---

## 18. Where the code goes

Repo layout. No new conventions.

```
src/shared/enums/reward.enum.ts            all the enums in §5
src/shared/contracts/rewards/
    reward.contract.ts                     Zod. The benefit + condition unions live here

src/database/repositories/                 FLAT, one per aggregate — repo convention
    reward-program.repository.ts
    reward-rule.repository.ts              rules + conditions + benefits (one aggregate)
    reward-award.repository.ts             awards + cap counters + benefit rows
    reward-wallet.repository.ts            wallets + ledger entries
    reward-entitlement.repository.ts

src/modules/rewards/
    rewards.module.ts
    rewards.controller.ts                  parse → service → map. Nothing else
    rewards.service.ts                     business logic lives ONLY here
    rule-evaluator.service.ts              trigger match → conditions → benefits
    benefit-dispatcher.service.ts           the Record<Kind,Handler> + middleware
    conditions/time-window.condition.ts    one file per kind
    benefits/grant-points.benefit.ts         one file per kind. apply + compensate
    benefits/grant-currency.benefit.ts
    benefits/issue-entitlement.benefit.ts
    benefits/convert-value.benefit.ts
    

src/workers/reward-grant.worker.ts         hold expiry sweep. extends base-poller
```

**No forwarding worker.** `outbound-relay.worker.ts` already drains
`outbound_events` (§13.1).

**No new infrastructure.** `BaseRepository.manager` resolves the ambient
transaction, so `RequestContext.runInTransaction` makes N benefits atomic with
zero plumbing. `mutate()` returns `affected` — that is the `0 rows = capped`
check in §10.2. `base-poller`, `lease-reaper`, `backoff.util`, `queue-gauge`:
all reused.

**Migrations** go in `src/database/migrations/`, mirrored in
`schema-objects.ts`. Both. A migration not mirrored there fails schema parity.

### 18.1 Adding one benefit kind — the measured diff

```
reward.enum.ts                 +1 line    you choose this
benefits/send-notification.benefit.ts   NEW file   you write this
benefit.registry.ts             +2 lines   COMPILER DEMANDS IT, names the kind
reward.contract.ts             +1 variant COMPILER DEMANDS IT
```

4 files. 1 new. **3 of 4 forced by `tsc` by name.** Zero migrations.
Zero UI files — the admin form renders from the descriptor (§14).

Median across seven real OSS commits: 7 files, 1 of them logic.

---

## 19. V1 — built vs stubbed

| | |
| --- | --- |
| Programs, rules, versioning | **built** |
| `reward_rule_benefits` + `reward_award_benefits`, 1:N | **built** |
| Typed handler registry + compensator pairing | **built** |
| Three validation layers (write / read / CI drift) | **built** |
| 12 of 14 triggers | **built** (`post_caption_mention` inert until E8) |
| `post_like` / `post_share` | **blocked** — verify `todo.md` B4, then backlog §8.2 |
| Frequency caps, program budget | **built** |
| Points wallet + ledger | **built** |
| Currency wallets, multi-currency | **built** |
| Conversion rules | **built** |
| Award factor + `factor_inputs` | **seam + `constant_one`** — engine = backlog §8.1 |
| Entitlement rows | **written**, catalogue + redemption deferred |
| Forwarding | **seam + `noop`**, ledger no-op |
| Holds, reversal, negative balance | **built** |
| Review queue / fraud detection | **not built** — hook preserved |
| Tiers, expiry, breakage accounting | **not built** |

**Build order:**

```
0. benefit kinds + registry         ← payload map, Record completeness, 2 kinds only
1. schema + ledger + wallet        ← reconciler + immutability trigger
2. trigger normaliser + catalogue  ← no rules attached yet
3. rules + caps + award state machine   (points, fixed only)
4. factor seam                     ← incl. the zero-factor release test
5. currency + conversion + entitlement rows
6. forwarding seam + noop
7. FE: rule builder, balance view, award history
```

Steps 1–3 hold the correctness. Each is shippable alone.

---

## 20. Abuse — controls, not detection

**Have:** per-customer cap as a constraint, program budget failing closed, hold
before spendable, append-only ledger, `hide` as a free abuse signal (§6.5).

**Do not have:** anything against *ten* accounts instead of one. That is a graph
problem (market study §16.3), and naive versions flag most of your customers.

**Free wins we should not squander:**

- **Platform-scoped IDs make Sybil accounts expensive** — a second Instagram
  account needs a real phone number. Better barrier than most programs have.
- **We already hold interaction history.** `customer_engagements` knows when
  someone first appeared. A filter of *"must have engaged before today"* costs
  nothing and blocks the laziest farming.

Defer detection, **keep the hook**: awards carry `status` + `reason_code`, so a
review queue is a screen, not a migration.

---

## 21. Open

**Closed by the extensibility research (Oct 2026), recorded so the reasoning
survives:** 1:N benefits per rule; typed discriminator + `config JSONB` over
typed columns; flat AND conditions over a boolean tree; typed registry over
`DiscoveryService`; no durable-execution engine; no declarative benefit DSL
(measured: it does not reduce file count).

**Still open:**

| # | Question |
| - | -------- |
| 1 | **What should the factor engine measure?** Inputs, weighting, per-trigger or global. Backlog §8.1. A reach-based answer needs a Meta permission conversation first — `#10` blocks it today |
| 2 | **`budget_cost_minor` for points/items** — what does the enterprise consider a 20-point award to cost? Without it the budget guards only currency |
| 3 | **Who may `adjust` a balance**, under which permission. The entry type exists; the RBAC entry does not |
| 4 | **Retention.** Ledger entries are financial records and should outlive the 30-day transport window. Awards and counters probably follow the customer |
| 5 | **Does the customer ever see their own balance?** Nothing here surfaces it to them — it is an enterprise-facing view. A customer-facing one is a separate authenticated surface |
| 6 | **Does `award_mode` earn its place?** Two values, and the columns already say which: `award_cap` set ⟹ variable. Dropping it removes a redundant column and an invalid combination |
| 7 | **Customer merge.** `merged_into_customer_id` exists, nothing sets it. Wallets merge via `transfer_in`/`transfer_out`, never by repointing rows. Counters take `MAX(used)` per `(rule, period_key)`, **not** the sum, or merging grants a free slot |
