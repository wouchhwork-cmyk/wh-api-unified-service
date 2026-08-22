# How the backend actually works

A business-level walkthrough of the Wouchh API: what each thing is called, and for
every flow, what arrives, what gets written where, which rule is checked at which
point, and what goes back to the caller.

**This describes the code, not the plan.** Where the code and
[`backend-design.md`](backend-design.md) disagree, this document follows the code
and says so. Section 20 lists what is designed but not built — read it before
promising anything to anyone.

No SQL and no class names in the flow sections; the tables are named because the
tables *are* the business state.

---

## 1. The words we use

The product has a specific vocabulary, and most confusion about it comes from two
pairs that sound interchangeable and are not: **identity vs member**, and
**connection vs channel**.

### The people and the businesses

| We call it | Table | What it means |
| --- | --- | --- |
| **Enterprise** | `enterprises` | A business that signed up. The tenant. Almost every other table carries `enterprise_id` pointing here. Called "enterprise" rather than "business" because Meta's API already has a `business_id` and two different meanings for one word is a bug waiting to happen. |
| **Identity** | `identities` | A login. One row per human, and deliberately **not** tenant-scoped — this is the only thing that can sign in. Holds the email and/or mobile, the password hash, and the per-credential "this was proven" stamps. |
| **Member** (membership) | `enterprise_members` | One row per person per business. This is the tenant-scoped person that everything else points at, which is what keeps conversations, messages and assignments correctly scoped. One person working for three businesses is **one** identity and **three** members. |
| **Staff member** | `staff_members` | One of *our* people. `has_all_enterprise_access = true` means every business, present and future — the platform admin. Staff never sign up; there is no route that creates one from outside. |
| **Role** | `roles` | A named bundle of actions, owned by one business. The four enterprise templates (owner, manager, agent, viewer) are **copied into each business at signup**, because a template row belongs to no business and is structurally unassignable. |
| **Permission** | `permissions` | The global catalogue of grantable actions, as `resource.action` — `conversations.reply`. Each one optionally names the feature that gates it. |
| **Feature** | `features` | The product catalogue: `unified_inbox`, `comment_management`, `post_insights`, `customer_directory`. |
| **Enterprise feature** | `enterprise_features` | What one business is entitled to, and where that entitlement is in its lifecycle. **`status = 'active'` is the only thing that means "on"** — there is no separate boolean, deliberately, because that would be a second answer to the same question. |

### Signing in

| We call it | Table | What it means |
| --- | --- | --- |
| **Session** | `sessions` | One signed-in device, so it can be revoked server-side. The access token is stateless and never stored; what is stored is a keyed hash of the **refresh** token. |
| **Verification** | `verifications` | Every code or link in the product — first login, email and mobile checks, password resets, member invites — in one table with one verifier. Split per flow and you get several implementations, and the second one is where somebody forgets attempt limiting. |
| **Access token** | — | A short-lived JWT (15 minutes) naming the identity, the business it is scoped to, and the member or staff acting. **Carries no roles**: permissions are resolved per request, so a role change lands on the next request rather than the next login. |
| **Selection token** | — | A 5-minute token that proves a password check and nothing else. Issued only when one person belongs to several businesses. |

### The connected accounts

| We call it | Table | What it means |
| --- | --- | --- |
| **Provider connection** | `provider_connections` | One authorisation by one person: "this business connected Meta, and here is the long-lived user token and the scopes granted." |
| **Channel** | `channels` | One thing you can actually talk through: a Facebook Page, or an Instagram account attached to one. Holds its own Page token. An Instagram channel hangs off its Page as `parent_channel_id` and can inherit the parent's token. |
| **Customer** | `customers` | A member of the public who interacted with a business. Scoped to that business — the same person messaging two businesses is two customer rows, and they are not linked. |
| **Conversation** | `conversations` | One thread: a DM thread, or a comment thread under a post. |
| **Message** | `messages` | One message in a thread, inbound or outbound. |

### The plumbing that makes delivery reliable

| We call it | Table | What it means |
| --- | --- | --- |
| **Inbound event** | `inbound_events` | The ledger of everything Meta sent us, stored raw before anything is interpreted. |
| **Outbound event** | `outbound_events` | The ledger of everything we intend to send. A reply is written here in the same transaction as the message row — which is what makes "we said we sent it" and "we tried to send it" impossible to disagree. |
| **Sync job** | `sync_jobs` | A backfill request. **Rows are created and nothing consumes them** — see §20. |
| **Audit log** | `audit_logs` | Who did what to whom. Append-only by grant, not just by policy: the migration revokes UPDATE and DELETE from the application role. |

### The states worth memorising

- **Enterprise:** `pending_activation` → `active` → `suspended` → `active`. A signup lands in
  `pending_activation` and **cannot use the portal** until someone at Wouchh activates it.
- **Enterprise feature:** `access_requested` → `active` | `declined`; `active` → `disabled` | `expired` | `revoked`; `revoked` is terminal.
- **Inbound / outbound event:** `pending` → `processing`/`sending` → `processed`/`sent`, or `failed` → `dead_letter`, or `skipped`.

---

## 2. What happens to every request

Six gates, in this order. Each one is global — a route is protected unless it
says otherwise, so forgetting a decorator fails closed.

| # | Gate | What it decides | If it says no |
| --- | --- | --- | --- |
| 0 | **Rate limit** | 120 requests per 60 seconds, per client IP **per route handler**. Applies to authenticated routes too. | `429`, with `Retry-After` |
| 1 | **Authentication** | Is there a valid Bearer token, and does it carry every claim the application relies on? Builds the actor. | `401 AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` |
| 2 | **Enterprise scope** | Does the token name a business? Only routes that declare a permission need one. | `403 AUTH_ENTERPRISE_NOT_SELECTED` |
| 3 | **Business is usable** | Is that business `active`? Staff are exempt — somebody has to be able to look at a business to decide whether to activate it. | `403 ENTERPRISE_PENDING_ACTIVATION` or `ENTERPRISE_SUSPENDED` |
| 4 | **Permission** | Does the actor hold every code the route declares? Deny by default: an empty set passes nothing. | `403 PERMISSION_DENIED`, naming the missing codes |
| 5 | **Platform admin** | For the internal console only: is this one of our own staff, with platform-wide reach? Re-read from the database every request, never trusted from the token. | `403 PERMISSION_DENIED` |

Gate 1 does the work everything else depends on, and it does it **per request**:
it resolves the caller's permissions freshly each time by applying two independent
gates.

> **The two-gate rule.** *Gate A: does the business have the feature?* (commercial)
> *Gate B: do the person's roles grant the action?* (structural) Neither implies
> the other, which is why they are separate tables rather than one grant. A
> feature the business does not have **does not exist for anyone** — including our
> own staff, whose platform-wide access grants *reach*, not *entitlement*.

Around the gates:

- **Every response has the same envelope.** Success is `{ success: true, data, meta }`.
  Failure is `{ success: false, error: { code, message, details? }, meta }`.
  `meta.requestId` is the correlation id, echoed as the `x-correlation-id` header
  and present in every log line for that request.
- **Errors are machine-readable first.** A stable `code` per failure, mapped to a
  status. Stack traces, SQL and internal ids never reach a client.
- **A request that outlives its budget is cut off** at 15 seconds with `408`.

---

## 3. A business signs up

`POST /api/v1/enterprises/signup` — public.

The business sends its own details and the owner's, including a password of at
least 10 characters. The owner must give an email or a mobile; both is fine.

1. **Normalise everything, once, here.** The email is lower-cased; the mobile is
   parsed to E.164 and stored decomposed. Normalisation never happens at read time
   and never in two places.
2. **Pick a slug** from the business name, suffixing until it is free. Racy by
   nature, so the unique index is still the real defence.
3. **One transaction** writes: the `enterprises` row (as **`pending_activation`**),
   the owner's `identities` row with an argon2id password hash, the
   `enterprise_members` row (active immediately), this business's **own copies** of
   the four role templates, and the owner's role grant. All of it or none of it.
4. **Outside that transaction,** issue the verification: supersede any live code
   for the same destination and insert the new one, together, so two live codes
   for one destination cannot exist.
5. **Attempt delivery** — see §4.

**No session is issued.** Signup always ends in a challenge, so an unproven
address can never hold a session.

**Response `201`:** the business's `refId` and slug, the owner's `identityRefId`
and `memberRefId`, the **`verificationRefId`**, and the masked destination
(`me***@bluebottle.test`). Only reference ids cross the boundary; a numeric id
never does.

| Also possible | |
| --- | --- |
| Missing field, unknown extra field, password under 10 characters, owner with neither credential | `422 VALIDATION_FAILED`, one `details` entry per problem |
| Email or mobile already registered | `409 EMAIL_ALREADY_REGISTERED` / `MOBILE_ALREADY_REGISTERED` |
| Slug taken by a live business | `409 ENTERPRISE_SLUG_TAKEN` |
| More than 5 codes to one destination in an hour | `429 AUTH_RESEND_TOO_SOON` — **note:** the business is already committed at this point, and the owner has no code |

---

## 4. Getting the code to the person

One function decides everything, reading one switch: **`OTP_REALTIME_ENABLED`**.

**Off (the default, and every environment today):** nothing is sent anywhere, and
every numeric code issued is the fixed **`OTP_STATIC_CODE`** — `666666`. This is
what makes the whole product walkable before an SMS or email contract exists. A
warning is logged with the destination **masked** and the code absent.

**On:** the provider is called. Today that provider is a mock that accepts
everything and sends nothing; swapping in a real vendor is one line in one module,
and touches no flow.

Two deliberate choices:

- **Link tokens stay random.** Only numeric codes are fixed. A token travels
  inside a link rather than through someone's fingers, so predictability buys no
  convenience and gives away the whole secret.
- **Production cannot do this.** The service **refuses to boot** with
  `NODE_ENV=prod` and `OTP_REALTIME_ENABLED=false`, because a known constant would
  let anyone verify any address they can type.

A delivery failure is logged loudly and **not thrown**. The verification row is
already committed, so failing the request would tell the person their signup broke
when only the SMS did. Their recourse is to try again.

---

## 5. Submitting the code

`POST /api/v1/auth/verify` — public. Body: the `verificationRefId` and the code.

The client posts back **the opaque reference, never the destination**. That keeps
the address out of a second request and makes it impossible to verify a code
against a different address than it was sent to.

1. **Find the live challenge** by reference — live meaning not consumed, not
   superseded, not deleted.
2. **Check expiry** before anything else. Ten minutes for a first login.
3. **Spend an attempt, atomically,** with a conditional update that only succeeds
   while the count is under the maximum (5). Spent **before** the comparison, so a
   flood of guesses cannot outrun the counter.
4. **Compare** against the stored HMAC. The plaintext is never stored, and the
   key is a server-side pepper that lives outside the database — which is what
   makes a leaked table worthless.
5. **Consume it** — single use.
6. **Stamp the credential proven**, matching the destination the code actually went
   to, then issue the session.

**Response `200`:** the same three-outcome shape as login (§6).

| Also possible | |
| --- | --- |
| Wrong code | `401 AUTH_CODE_INVALID` |
| Attempts exhausted | `429 AUTH_CODE_ATTEMPTS_EXCEEDED` |
| Expired | `410 AUTH_CODE_EXPIRED` |
| Already used, superseded, or unknown reference | `404 VERIFICATION_NOT_FOUND` — a replay is indistinguishable from an unknown reference, on purpose |

---

## 6. Signing in

`POST /api/v1/auth/login` — public. Either an email or a mobile, plus a password.
Exactly one credential; sending both is a validation error.

**Login does not enforce the password policy.** It requires a password to be
present and nothing more. Enforcing strength here would tell an attacker the policy
for free and would lock out any account whose password predates it — including
internal accounts provisioned from configuration — behind a `422` that looks
nothing like "wrong password". Whether a password is correct is a question for the
hash.

1. **One index probe** finds the identity, by lower-cased email or canonical mobile.
2. **Verify the password first,** before any account-state check. An unknown
   credential is compared against a real decoy hash so the timing does not reveal
   whether the account exists.
3. **Only then** say why a correct password still cannot sign in: 5 failures set a
   15-minute lock, in a single non-interleavable update.
4. **Decide whether a code is needed:** is the credential being used already
   **proven**? Not "is this the first login" — proof is the question, which is why
   an account provisioned from configuration signs straight in while a fresh
   signup is always challenged.
5. **Resolve memberships** and produce one of three outcomes.

Login has **three** outcomes, as separate shapes rather than one shape with
everything optional, so a client cannot misread which it got:

| `outcome` | When | What the client does |
| --- | --- | --- |
| `authenticated` | One business, or a staff account | Store the access token. The refresh token arrived as an httpOnly cookie. |
| `verification_required` | The credential is not yet proven | Go to the code screen with the `verificationRefId` |
| `enterprise_selection_required` | Several businesses | Show a picker, then exchange the `selectionToken` |

A staff account signs in with **`enterprise: null`** — the only legitimate case of
a session with no business scope.

---

## 7. Choosing, switching, refreshing, leaving

| Flow | Route | What matters |
| --- | --- | --- |
| **Choose a business** | `POST /auth/select-enterprise` | Exchanges the 5-minute selection token plus a business reference for a real session. The membership is re-checked here. |
| **Switch business** | `POST /auth/switch-enterprise` | Mints a token scoped to another business without signing in again. Staff may switch into **any** business — recorded as impersonation. Returns `201` (no explicit status override). |
| **Refresh** | `POST /auth/refresh` | Reads the httpOnly cookie, resolves the session by keyed hash, issues a new access token. **Only re-checks the membership when `?enterpriseRefId=` is supplied** — see §20. |
| **Sign out** | `POST /auth/logout` | Revokes the session by refresh-token hash and clears the cookie. `204`. Logging out an already-dead session succeeds. |
| **Who am I** | `GET /auth/me` | What a client needs after a page reload when all it holds is a token: whether this is an internal admin, which business, **that business's status**, and the permission codes. No internal ids. |

---

## 8. The internal console

Wouchh's own staff. **Login only — there is no staff signup and there never will
be,** because a self-service route to a staff account would be the worst hole in
the product.

### Where the first admin comes from

Configuration, at boot. `PLATFORM_ADMIN_ENABLED` plus a name, email, mobile and
password provisions exactly one staff login with platform-wide reach. It runs on
every boot and is idempotent, and the configured credential is treated as the
**source of truth**: change the environment and restart, and the password changes.
That is also the recovery path when it is lost.

The credential is marked proven without a code, deliberately — an operator put it
in the deployment environment, which is a stronger claim of control than any code
sent to it, and challenging it would lock the account out of its own first login.

Production requires that password to be at least 16 characters.

### What the console can do

Every route is behind gate 5 and declares **no** permission. Platform reach is a
separate axis from permissions on purpose: permissions are granted by roles that
live inside a business and are gated by what that business has bought — the wrong
shape entirely for "this person works for us". It also means no role edit,
however misconfigured, can ever grant platform reach.

| Route | What it does |
| --- | --- |
| `GET /platform/overview` | Businesses by status, and platform totals: customers, channels, conversations, pending feature requests. |
| `GET /platform/enterprises` | Every business, newest first, with per-business counts (members, channels, connections, customers, conversations, features). Free-text search over name, slug and email; status filter; keyset pagination on `(createdAt, id)` so pages cannot skip or repeat. |
| `GET /platform/enterprises/{refId}` | One business in full: profile, owner, every feature and its state, every connected channel. |
| `POST /platform/enterprises/{refId}/status` | Activate or suspend. |
| `POST /platform/enterprises/{refId}/features/{featureKey}` | Grant, disable, decline or revoke a feature. |

Two things the console deliberately does **not** do:

- **It returns no customer, conversation or message content.** "See every business"
  never becomes "read every business's inbox".
- **The owner's email and mobile are masked**, even for an admin. An admin needs to
  recognise the account, not read the customer's personal data — and this is the
  response most likely to end up in a screenshot or a support ticket.

Every mutation writes an `audit_logs` row naming the staff member, the business
affected, the before and after values, and the reason where one was required.

---

## 9. Activating a business

This is what makes signup a decision somebody makes rather than a side effect of
filling in a form.

`POST /api/v1/platform/enterprises/{refId}/status` with `{"status": "active"}`.

1. **Resolve the business** by reference.
2. **Check the transition** against the state machine. Activating an already-active
   business is a clear `409`, not a silent no-op that looks like success.
3. **Update conditionally on the current status.** If two admins click at once the
   second update matches nothing and the caller is told, rather than both
   succeeding and the later one quietly winning.
4. **Audit it.**

**Suspending requires a reason** — it is the only record of why — and that reason
goes in the audit row.

**The effect is immediate.** The gate is evaluated per request, so the owner's
existing token starts working the moment the business is activated, and stops the
moment it is suspended. No re-login, and no waiting for tokens in the wild to
expire.

What the owner experiences while pending: every tenant-scoped route returns
`403 ENTERPRISE_PENDING_ACTIVATION` with a message fit to show a person, while
`/auth/me` keeps working — otherwise they could never learn *why* they are blocked.

---

## 10. Features

A feature is the commercial half of access control. Granting one is what makes its
actions available to a business's staff **at all**; a role cannot grant what the
business does not have.

The catalogue is `unified_inbox`, `comment_management`, `post_insights`,
`customer_directory`. A business that has never had a feature has no row for it,
which reads the same as not enabled.

An admin may grant a feature the business never asked for — that is how a plan
gets provisioned. Anything else follows the state machine, and disabling a feature
that was never granted is a `409` rather than a silent insert.

The effect on the business is immediate and needs no new login: permissions are
resolved per request, so the owner's very next call sees the new codes.

**A business cannot request a feature today.** The `access_requested` state, the
`features.request` permission and the whole request path exist in the schema with
no endpoint — see §20.

---

## 11. Connecting Facebook and Instagram

Modelled on a working implementation, and every Graph call mirrors calls proven in
production. **It has not yet run against real Meta credentials from this
codebase.**

### Starting

`GET /api/v1/connections/meta/connect` — needs `channels.connect`.

Returns the URL to send the person to: Facebook Login for Business, identified by
a **configuration id** rather than a scope list (the config decides the scopes),
plus a signed **state** token carrying the business and the member who started it.

### Coming back

`GET /api/v1/connections/meta/callback` — public, because Meta redirects the
browser here.

1. **Refuse early if Meta is not configured** (`503`) — before the state is even
   examined.
2. **Verify the state**: signature, then expiry, then that it names a business.
3. **Exchange the code** for a short-lived user token, then exchange *that* for a
   long-lived one.
4. **Ask who this is**, and list the Pages they manage — each Page arriving with
   its own Page token and, expanded in the same call, its attached Instagram
   business account.
5. **Confirm the scopes actually granted**, falling back to inspecting the token
   when the authorisation response does not say.
6. **Write it down:** one `provider_connections` row for the authorisation, then
   one `channels` row per Page, and one more per Instagram account with the Page
   as its parent. Every token is encrypted at rest under a versioned envelope, so
   a key can be rotated without rewriting old rows.
7. **Subscribe each Page** to `messages`, `messaging_postbacks`, `feed` and
   `mention`.
8. **Enqueue backfill jobs** — which nothing consumes yet (§20).

**Always a redirect, never a JSON body.** The callback catches everything and
answers with a `302` back to the dashboard, carrying a stable reason code on
failure — never a provider message.

**The same Page connected by two businesses is allowed** and works: attribution is
per channel, and one delivery from Meta fans out to one ledger row per matching
business.

### When a token dies

Meta says either "the 24-hour window closed" (subcode 2534022) or "this token is
gone" (code 190). The second marks the connection **and its channels** as needing
re-authorisation. That write is scoped to the business as well as the connection —
composite foreign keys protect the *shape* of the data, but only the predicate
protects the *write*.

A flagged channel makes replies fail fast with `409 CHANNEL_REAUTH_REQUIRED`
rather than attempting a doomed send.

---

## 12. Something arrives from Meta

### The handshake

`GET /api/v1/webhooks/meta` — public. Meta calls this once when a webhook is
registered, with a challenge. If the verify token matches, the response is the
bare challenge string, as plain text with **no envelope** — Meta wants the value,
not our JSON.

### A delivery

`POST /api/v1/webhooks/meta` — public, and the only endpoint authenticated by
signature rather than by token.

1. **Refuse if Meta is not configured** (`503`), before any signature check.
2. **Verify the signature** over the **raw** body. This is why the app is
   configured to keep the raw body: a re-serialised payload produces a different
   HMAC, and verification would fail every time. A bad signature is `401` and
   nothing is stored.
3. **Attribute each entry to a business via the channel** — the Page id, never
   anything in the payload claiming a business. An entry naming a Page nobody has
   connected is counted as unmatched and **dropped with no ledger row**.
4. **Store raw, interpret later.** One `inbound_events` row per item per matching
   business, with a dedup key derived from the item's own identity — and, for feed
   changes, the verb, so an `add` and a subsequent `remove` are different events.
   A redelivery collides on that key and is counted as a duplicate.
5. **Answer `200` immediately** with `{ received: true }`.

That last point is the whole design. Meta retries anything that is not a prompt
`200`, so the endpoint's only job is to get the payload durably recorded.
Interpretation happens in a worker, where a failure can be retried without asking
Meta to send it again. The counts are logged; the response body carries none of
them.

### Turning a payload into an inbox item

A worker claims pending rows in batches, ordered by priority, using
`FOR UPDATE SKIP LOCKED` so two workers can never take the same row.

For a **comment** or a **direct message**, in one transaction:

1. **Find or create the customer** — scoped to this business, keyed on the platform
   user id, so the same person is one row however many times they write.
2. **Find or create the conversation**, keyed on a thread id — `comment:<id>` for a
   comment thread, `dm:<id>` for a DM thread.
3. **Insert the message**, keyed on the platform message id, so a replay updates
   nothing.
4. **Mark the ledger row processed.**

Everything is keyed on identity rather than arrival, which is what makes
at-least-once delivery safe. A failure schedules a retry with backoff; a spent
budget lands in `dead_letter` for a human. Out-of-order arrivals are absorbed
because the thread is found or created by key rather than assumed to exist.

**Mentions and post updates are recorded and skipped** — no projector exists.
Inbound attachments are recorded only as a message kind; the media is never
fetched (§20).

---

## 13. Reading the inbox

Six routes on `/api/v1/conversations`, each declaring a permission.

| Route | Permission | What it does |
| --- | --- | --- |
| `GET /` | `conversations.view` | The queue: newest activity first, optional status filter, "assigned to me", cursor pagination. |
| `GET /{refId}` | `conversations.view` | One thread's messages. |
| `POST /{refId}/reply` | `conversations.reply` | §14. |
| `POST /{refId}/assign` | `conversations.assign` | Assign to a member, or unassign. |
| `POST /{refId}/status` | `conversations.manage` | Move it through its workflow. |
| `POST /{refId}/read` | `conversations.view` | Clear the unread count. |

Every query is scoped to the business from the token. Tenant scoping is not a
filter someone remembers to add — the repository layer refuses to build a
tenant-scoped query without it.

---

## 14. Replying

`POST /api/v1/conversations/{refId}/reply` — needs `conversations.reply`.

The interesting part is what happens **synchronously** versus after.

Synchronously, in **one transaction**: the `messages` row (as `pending`) and the
`outbound_events` row that will cause it to be sent. Both or neither. If these
were separate, a crash between them would leave either a message we show as sent
and never send, or a send with nothing to show.

Then the response, immediately: **`202 Accepted`** with the message reference and
`pending`. The caller is told the reply is *accepted*, not *delivered*, because
that is the truth — delivery has not been attempted yet.

**Sending the same reply twice is safe.** With a client-supplied idempotency key,
a retry returns the original message rather than posting again, backed by a unique
index rather than an in-memory cache.

An **internal note** writes the message and no ledger row: it is never sent.

### The relay

A worker leases due rows, then for each one:

1. **Re-check the lease** immediately before the platform call. A worker that
   stalled long enough for its lease to lapse must not send.
2. **Send**, using the channel's token — or the parent Page's, for Instagram.
3. **Write the outcome back, fenced on still owning the lease**, so a revived
   zombie worker cannot overwrite the result of whoever took over.

Failure is classified rather than blanket-retried:

- **Retryable** (rate limits, 5xx, transport): backoff and try again, up to the
  row's budget (3 attempts), then `dead_letter`.
- **Terminal** (a rejected message, a closed messaging window, a dead token):
  settle the ledger row and the message together as failed. No retry will help.
- **Ambiguous** — the send may or may not have happened: **cancelled, never
  retried.** Sending a customer the same message twice is worse than not sending
  it, and we cannot tell which happened. Reading back to find out is not built
  (§20).

---

## 15. The workers

There is **no Redis and no queue**. Postgres is the queue, and the mechanics are
worth understanding because they are what makes the system safe without one.

**Claiming.** A worker takes a batch with `FOR UPDATE SKIP LOCKED`, which hands
each row to exactly one worker and lets the others skip past rather than block.

**Leasing.** A claimed row records who holds it and until when. Every write-back
is conditional on still holding it — that is *fencing*, and without it a worker
that froze past its lease could wake up and overwrite the work of whoever took
over.

**Reaping.** A separate worker reclaims rows whose lease lapsed. This is what
recovers from a worker process being killed mid-send: without it, an expired lease
alone does not make a row claimable again, because the claim query only looks at
pending and failed rows.

**Polling.** An empty poll backs off to 10 seconds; a partial batch re-polls in 2;
a full batch re-polls immediately, so a backlog drains at full speed.

| Worker | What it does |
| --- | --- |
| **Inbound projector** | Turns stored payloads into customers, conversations and messages. |
| **Outbound relay** | Sends replies and comment actions. |
| **Lease reaper** | Reclaims work abandoned by a dead process. |
| **Sweeper** | A 3am retention pass that hard-deletes settled verifications older than 7 days and expired sessions older than 30, in throttled batches. |

**They run in a separate process** from the API, with no HTTP server. A backlog
cannot starve the API, and neither can be reached from outside. **If that process
is not deployed, webhooks accumulate as pending rows forever and nothing is ever
projected.**

---

## 16. Health, errors and logging

**Health.** `live` answers without touching the database — a liveness probe that
fails on a database blip would restart a healthy process and make an outage worse.
`ready` and `startup` do check it. `detail` is the diagnostic view and requires
`enterprise.view`. Unhealthy is `503`, and none of them reveal a version, host or
dependency detail to an unauthenticated caller.

**Errors.** One stable code per failure, mapped to one status: 4xx for the
caller's problem, 5xx for ours. A `details` array names the offending fields on a
validation failure. A 5xx **never** carries the underlying message — only a
generic sentence and the request id, which is the thread back to the logs.

**Logging.** Structured, with a correlation id on every line, tying a request to
its ledger rows. What is deliberately **never** logged: verification codes, access
or refresh tokens, provider tokens, passwords. Destinations are masked at the point
of logging (`me***@bluebottle.test`, `+9198***5688`), not filtered afterwards.

**Configuration.** Nine groups, validated at boot by one schema. A missing or
malformed variable **stops the process** — it never defaults to something
plausible, because a service running with the wrong secret is worse than one that
refuses to start. Production additionally refuses placeholder secrets, an
unencrypted database connection, a static OTP, and a short platform admin
password.

---

## 17. Where the tenant boundary is actually enforced

Worth stating plainly, because it is the thing most likely to be got wrong later.

1. **The token names the business.** Nothing in a request body is ever trusted to
   say which tenant it belongs to.
2. **Composite foreign keys make cross-tenant rows unrepresentable.** A
   conversation cannot point at another business's channel; Postgres rejects it.
3. **But composite keys protect the shape of the data, not the write.** Only a
   predicate protects a write. Every tenant-scoped update names the business in
   its `WHERE` clause; the one place that once did not could have let one
   business's dead token revoke another's connection.
4. **Cross-tenant reads live in exactly one file,** named for what it is, reachable
   only behind the platform gate — so a reviewer can find every one of them by
   opening one file.

---

## 18. What the frontend needs to know

The portal in `wh-web-web-portal` uses only these:

| Screen | Calls |
| --- | --- |
| Sign in | `POST /auth/login`, then `POST /auth/select-enterprise` if a picker was shown |
| Create a business | `POST /enterprises/signup` |
| Enter the code | `POST /auth/verify` |
| Where do I go now | `GET /auth/me` — `isPlatformAdmin` decides console or portal; `enterprise.status` decides what the portal shows |
| Admin console | `GET /platform/overview`, `GET /platform/enterprises`, `GET /platform/enterprises/{refId}`, the two `POST`s |

Two rules for any client:

- **Never send the destination twice.** After signup or a challenged login, the
  only thing to hold is the `verificationRefId`.
- **The refresh token is not yours to read.** It is an httpOnly cookie, so every
  request must be credentialed, and the page must be served from an allowed origin.

---

## 19. What is verified, and how

- **68 automated tests**: schema guarantees against real Postgres, ledger
  concurrency, the onboarding and platform flows end to end through the real guard
  chain, and unit tests for normalisation, contracts and every production boot
  refusal.
- **Verified live** end to end: signup → fixed code → session → blocked while
  pending → admin activates → same token works → feature granted → permissions
  appear → suspended → blocked again, with audit rows for every admin action.
- **Not verified against Meta.** Every Graph call mirrors a proven
  implementation, but no call in this codebase has been made with real credentials.

---

## 20. What is designed but not built

Read this before promising anything.

### Nothing consumes these

| | |
| --- | --- |
| **Backfill** | Jobs are enqueued when a channel connects. Nothing claims them, so a business connecting a Page sees only what arrives *after* it connected — no history. |
| **Attachments** | Inbound media is never downloaded. A DM with an attachment becomes a message marked as an image regardless of the real type, and no attachment row is written. |
| **Token expiry warnings** | The hourly sweep logs a line and moves no token to an expiring state, so a channel whose token dies simply goes quiet. |
| **Feature expiry** | Nothing acts on `expires_at`; a feature never moves to `expired` on its own. |

### No endpoint exists for these

Members and invites; roles; a business requesting a feature; the customer
directory (the query is written, nothing exposes it); posts; comment hide and
delete; resending a verification code.

### Known weaknesses in what *is* built

| | |
| --- | --- |
| **Refresh does not re-check membership** unless the caller passes `?enterpriseRefId=`. Removing someone from a business does not end their existing sessions. |
| **Nothing revokes sessions** when a membership, identity or business is suspended. Sessions are unbounded per identity and are removed only by the 30-day retention sweep. |
| **The OAuth state token is not single-use**, despite being described as such. It is signed and expiring, and replayable within its window. |
| **Membership status is not read** when resolving permissions, so a suspended member keeps their permissions. |
| **A role's scope is not enforced at assignment** — only composite foreign keys stand between a staff role and a business member. |
| **Malformed reference ids on the conversation routes are `500`s**, not `422`s: those five routes do not validate the path parameter. The platform routes do. |
| **The correlation id is client-supplied** if a header is sent, so it is not trustworthy as an audit anchor. |
| **The resend cooldown is configured and unenforced**; only the hourly per-destination cap of 5 applies, and it counts every kind of verification to that destination. |
| **Ambiguous sends are cancelled, never reconciled.** Reading back to discover whether the message actually landed is not built. |
| **`recordDelivery` is the one tenant-scoped write with no tenant predicate** — it keys on the ledger row instead. |
| **Only `archived` blocks a reply**, despite a `CONVERSATION_CLOSED` code existing; resolved and closed threads are still repliable. |

### Not started

Audit coverage beyond the platform console (auth and inbox actions write nothing);
a CI pipeline; a committed OpenAPI document; ESLint configuration (`pnpm lint`
currently fails — there is no config file); metrics; a real email or SMS provider;
row-level security; partitioning; a secret manager.
