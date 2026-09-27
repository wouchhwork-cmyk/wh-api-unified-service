/**
 * Code invariants — values that do not change per environment.
 * Anything an environment might want different is config, not a constant
 * (backend-design.md §11 rules 5 and 6).
 */

/** Pagination. An unbounded list endpoint is a denial-of-service primitive. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Platform history is walked in pages of this size. */
export const SYNC_PAGE_SIZE = 100;

/** Body limits. Meta webhook batches are small; a reply is text. */
export const MAX_JSON_BODY_BYTES = 1_048_576; // 1 MiB
export const MAX_WEBHOOK_BODY_BYTES = 524_288; // 512 KiB

/** Message and note text. */
export const MAX_MESSAGE_BODY_CHARS = 5_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Inline ledger payload cap; larger bodies spill to object storage (schema.md §23 req 7). */
export const MAX_INLINE_PAYLOAD_BYTES = 65_536; // 64 KiB

/** Client-supplied idempotency keys. */
export const MIN_IDEMPOTENCY_KEY_CHARS = 8;
export const MAX_IDEMPOTENCY_KEY_CHARS = 64;

/** OAuth state token lifetime — long enough to finish a consent screen. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Retry policy for outbound platform calls. */
export const MAX_SEND_ATTEMPTS = 5;
export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 5 * 60 * 1000;

/** Per-call timeout for a platform HTTP request. */
export const PLATFORM_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The timeout for a platform call that NOBODY IS WAITING ON.
 *
 * Three tiers, each set by who is blocked: a read path gets
 * READ_PATH_PLATFORM_BUDGET_MS, ordinary work gets
 * PLATFORM_REQUEST_TIMEOUT_MS, and a refresh running behind a response that has
 * already been sent gets this.
 *
 * Measured, not guessed. Refreshing eighteen mentions found one whose query
 * Meta answers in 7–8.5 seconds standalone — close enough to ten that it was
 * cut off on every attempt inside the server, while the other seventeen
 * finished. Ten seconds is the right ceiling when a worker is holding a lease;
 * it is an arbitrary one when the alternative is simply never refreshing that
 * mention.
 */
export const BACKGROUND_PLATFORM_TIMEOUT_MS = 30_000;

/**
 * How long past its lease a SENDING row is left alone before the reaper takes it.
 *
 * The reaper cannot tell a dead worker from a slow one. A row was reclaimed the
 * instant its lease expired, so a reply whose Graph call was merely slow got
 * re-dispatched while the first request was still in flight — and the customer
 * received it twice.
 *
 * The window that matters is narrow: the relay re-checks its lease immediately
 * before sending, so a row whose lease lapsed BEFORE its send began is skipped,
 * not sent. The only in-flight case is a lease that expired mid-call, which is
 * bounded by the platform timeout. Twice that is the margin.
 */
export const SENDING_REAP_GRACE_MS = PLATFORM_REQUEST_TIMEOUT_MS * 2;

/**
 * How many times a single inbound event may fail projection before it is
 * dead-lettered. Was an unnamed 3 at the call site, which meant the retry budget
 * for the busiest queue in the service was invisible to anyone tuning it.
 */
export const MAX_PROJECTION_ATTEMPTS = 5;

/** Login throttling (schema.md §2). */
export const MAX_FAILED_LOGINS = 5;
export const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;

/**
 * How many live sessions one person may hold at once.
 *
 * Every login and every enterprise selection INSERTs a `sessions` row and
 * revokes nothing, and refresh deliberately does not rotate — so the only thing
 * that ever removed a row was the 30-day retention sweep, and the number of live
 * refresh tokens per identity was bounded by nothing but how often somebody
 * signs in. Each one of them is a credential that mints access tokens for seven
 * days.
 *
 * TEN rather than the three or four devices a person actually uses, because a
 * session is per device AND per enterprise selection: somebody who works in
 * several businesses mints a row for each business they pick, on each device. The
 * cap has to sit above devices × businesses or it would sign people out of work
 * they are still doing. Past it the OLDEST live session goes first, so the worst
 * case for a legitimate person is that their least recently created session asks
 * them to sign in again — never the one they are using, which is by definition
 * the newest.
 */
export const MAX_SESSIONS_PER_IDENTITY = 10;

/**
 * Per-route throttle for the unauthenticated credential endpoints.
 *
 * The global limit is 120/min, which is right for a logged-in client rendering
 * an inbox and far too generous for a password guess: it allowed 120 attempts a
 * minute per address against an account-state check that, by design, only
 * refuses AFTER the password is proven. These are the routes where a request is
 * an attempt at a secret, so they get their own budget.
 */
export const CREDENTIAL_ATTEMPTS_PER_MINUTE = 10;

/**
 * How long one SSE stream may stay open before the client must reconnect.
 *
 * An open stream was the one authorisation in the service with no expiry: it was
 * checked once, at connect, and then delivered tenant activity for as long as a
 * browser tab stayed open — past the 15-minute access token that opened it, and
 * past the employee being suspended. Capping the stream makes the client come
 * back through the guard chain with a current token, which is the only place
 * that check belongs.
 */
export const SSE_MAX_STREAM_MS = 10 * 60 * 1000;

/**
 * Backfill policy (schema.md §15).
 *
 * MAX_PAGES_PER_RUN bounds one claim rather than one job: a Page with years of
 * history must not hold a lease for the whole walk, so a run takes a slice,
 * saves its cursor and lets the next poll continue. That also means a crash
 * loses one slice, never the whole walk.
 */
export const SYNC_MAX_PAGES_PER_RUN = 5;
export const SYNC_MAX_ATTEMPTS = 5;

/**
 * Comments fetched per post in the same pass. Graph nests comment paging inside
 * feed paging, and walking both cursors at once is where backfills go wrong;
 * this caps the nested edge and the worker LOGS when a post is truncated rather
 * than pretending it copied everything.
 */
export const SYNC_COMMENTS_PER_POST = 50;

/**
 * How much of a tagged post's comment section we keep alongside a mention.
 *
 * The room around a mention, not the conversation: these comments are
 * ANONYMOUS — Instagram omits the author on every one of them
 * (docs/platform-limitations.md §1.4) — and unanswerable, since a comment on
 * somebody else's post can only be replied to if it tagged us.
 *
 * Capped because it is stored per mention, and a viral post is not a bounded
 * thing: `@urudaymotivation`'s had 5,738 comments against three mentions of
 * ours. Fifty is also all Instagram returned in one page, so this matches what
 * the platform actually gives rather than inventing a target.
 */
export const MENTION_POST_COMMENTS_KEPT = 50;

/**
 * How many projection attempts a `message_edit` naming an unknown message waits
 * before we treat the delivery as genuinely lost.
 *
 * Meta can deliver the edit BEFORE the message it edits — observed 0.7 seconds
 * apart on live traffic — so an orphan edit is not proof of a dropped webhook.
 * Acting on the first sight of one fired a resync that recovered nothing:
 * `synced_item_count: 0`, one Graph call spent to be told what we already knew a
 * moment later.
 *
 * One attempt is enough. The ledger's retry backoff is seconds, which is orders
 * of magnitude longer than the gap Meta actually produces, and a genuinely lost
 * delivery is recovery rather than real-time work — so paying one backoff cycle
 * to avoid a pointless platform call is the right trade.
 */
export const ORPHAN_EDIT_GRACE_ATTEMPTS = 1;
/*
 * TWENTY, because that is Meta's ceiling, not ours: "You can only get details
 * about the 20 most recent messages in the conversation. If you query a message
 * that is older than the last 20, you will see an error that the message has
 * been deleted." Asking for 50 implied a depth the edge cannot serve.
 */
export const SYNC_MESSAGES_PER_CONVERSATION = 20;

/** How long a rate-limited sync job waits before it may be claimed again. */
export const SYNC_RATE_LIMIT_PARK_MS = 15 * 60 * 1000;

/**
 * How long a rate-limited SEND waits before it may be claimed again.
 *
 * Deliberately not the exponential curve. That curve is tuned for a transient
 * fault and spans about three seconds across the whole attempt budget, so a
 * rate limit — which lasts minutes — used to exhaust every attempt while the
 * limit was still in force and dead-letter a reply the platform would have
 * accepted a few minutes later.
 */
export const OUTBOUND_RATE_LIMIT_PARK_MS = 5 * 60 * 1000;

/**
 * How long a throttled send may keep waiting out a rate limit before it is
 * dead-lettered anyway.
 *
 * A rate limit does not consume the attempt budget — the whole point is that it
 * is a condition to be waited out, and burning attempts on it lost replies the
 * platform would have accepted minutes later. But "wait forever" is not a
 * policy either: a quota that never clears has to become visible to an operator
 * rather than a row that retries until the end of time. Measured from the row's
 * creation, so the bound is on the REPLY's age, which is what a customer
 * experiences.
 */
export const OUTBOUND_RATE_LIMIT_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * The window the dead-letter gauge warns on.
 *
 * The gauge counted every dead letter ever recorded, so one poison message from
 * last month pinned the alarm at WARN permanently — and an alarm that is always
 * on is an alarm nobody reads, which is worse than no alarm. The cumulative
 * total is still reported, for context; only the RECENT count decides whether
 * anything is wrong right now.
 */
export const DEAD_LETTER_ALERT_WINDOW_MS = 60 * 60 * 1000;

/**
 * LISTEN/NOTIFY channel names.
 *
 * Notification is an OPTIMISATION, never the delivery guarantee: every worker
 * still polls on its timer, so a dropped listener costs latency and nothing
 * else. Names are lower case because Postgres folds unquoted identifiers.
 */
export const NOTIFY_INBOUND_CHANNEL = 'wouchh_inbound_ready';
export const NOTIFY_OUTBOUND_CHANNEL = 'wouchh_outbound_ready';
export const NOTIFY_SYNC_CHANNEL = 'wouchh_sync_ready';

/** Coalesce a burst of notifications into one wake-up. */
export const NOTIFY_DEBOUNCE_MS = 50;

/**
 * TCP keepalive for the two connections that sit idle ON PURPOSE.
 *
 * A LISTEN connection sends nothing for as long as nothing is enqueued, and an
 * idle socket is what a NAT gateway or load balancer reclaims — usually without
 * a FIN, so neither end learns of it. Postgres keeps its side; we keep a client
 * that will never be told anything again. Nothing errors, nothing logs, and the
 * only symptom is that live updates quietly stop while the process looks
 * healthy.
 *
 * Keepalive turns that into a socket error, which both listeners already handle
 * by reconnecting. Thirty seconds sits under the idle timeouts that do this —
 * AWS NLB at 350s is the long end, many NAT devices are far shorter — and the
 * traffic is two packets a minute per connection.
 */
export const LISTEN_KEEPALIVE_DELAY_MS = 30_000;

/**
 * How long a resolved mention's media links are trusted before being refetched.
 *
 * Instagram serves media from signed CDN links that EXPIRE, and the expiry is
 * in the link itself — the `oe=` parameter, a hex Unix timestamp. Measured on
 * live data: a reel's `media_url` lasted about 35 hours and its thumbnail about
 * 4.5 days. We resolve a mention once, when it arrives, and used to serve that
 * answer forever — so anything opened a couple of days later showed a broken
 * image on a post that was perfectly fine.
 *
 * Six hours is chosen against the SHORTEST of those, not the average: a link
 * handed to a browser is at most six hours old, leaving well over a day of
 * validity for the session that receives it. Raising this towards 35 hours
 * would start serving links that expire while somebody is looking at them.
 *
 * The cost is one Graph call per mention thread opened more than six hours
 * after the last one — and only for threads somebody actually opens.
 */
export const MENTION_MEDIA_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a thread read will WAIT for a platform call before giving up on it.
 *
 * Far tighter than PLATFORM_REQUEST_TIMEOUT_MS, and deliberately so: ten
 * seconds is a reasonable budget for a worker that has nothing else to do and
 * an unreasonable one for somebody who clicked a conversation.
 *
 * MEASURED 19 Sep 2026 against the live API, which is what set this apart from
 * a guess:
 *
 *   profile_pic (a customer's picture)   756–866 ms
 *   mentioned_comment (a mention's media) 3.1–4.8 s
 *
 * So the picture is fetched inside the read and the mention is NOT — the
 * mention refresh runs behind the response instead (see
 * InboxService.refreshMentionMediaInBackground). Narrowing the mention query to
 * the two link fields was tried and changed nothing: the latency is in Meta's
 * mentions edge, not in the field expansion.
 */
export const READ_PATH_PLATFORM_BUDGET_MS = 1_500;

/**
 * How long a customer's profile picture is trusted before being refetched.
 *
 * Measured 19 Sep 2026 against the live API: a freshly fetched Instagram
 * `profile_pic` carried an `oe=` four to five days out. The one actually in the
 * database had been taken on 06 Sep and died on 10 Sep — nine days before
 * anybody noticed, because nothing ever looked at it again.
 *
 * A day is comfortable against four, and it also covers the OTHER half of the
 * problem: the picture is only fetched during a conversation backfill, so most
 * customers never had one at all. Refreshing on read fills those in too.
 */
export const CUSTOMER_AVATAR_TTL_MS = 24 * 60 * 60 * 1000;

/** How often the queue gauge is sampled and logged. */
export const QUEUE_GAUGE_INTERVAL_MS = 60_000;

/**
 * How often a Page's webhook subscription is read back and compared against
 * SUBSCRIBED_FIELDS.
 *
 * SIX-HOURLY, and the cost is what sets it: one Graph read per active Page per
 * run, plus a write only when something is actually missing. Four reads per Page
 * per day is nothing against the ordinary traffic of this service, and the
 * failure it detects is the worst one this product has — a subscription removed
 * on the Facebook side, or disabled by Meta after a run of non-2xx deliveries
 * (docs/platform-limitations.md §7.2), makes the inbox go quiet with no error
 * anywhere. Daily would leave a business silently unreachable for most of a
 * working day; hourly would spend six times the calls to shorten a window that
 * is already shorter than anyone's reaction time.
 *
 * Minute 17 deliberately: the expiry sweep runs at minute 0 of every hour and
 * the nightly jobs at 3, 4 and 5 AM, so this lands on an hour it shares with
 * nothing else rather than adding to a burst.
 */
export const WEBHOOK_RECONCILE_CRON = '17 */6 * * *';

/**
 * A ceiling per reconciliation run, so one run costs a bounded number of Graph
 * calls however many channels exist. Channels beyond the cap are picked up by a
 * later run.
 */
export const WEBHOOK_RECONCILE_CHANNELS_PER_RUN = 200;

/**
 * Meta's messaging window: a business may reply to a direct message only within
 * 24 hours of the customer's last message.
 *
 * Enforced on OUR side as well as Meta's, so a reply that cannot possibly be
 * delivered is refused at the door rather than accepted, queued, attempted and
 * dead-lettered — which tells the agent "sent" and the truth only later.
 */
export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Live inbox updates.
 *
 * One channel for every tenant, filtered per subscriber in the API process. A
 * channel per enterprise would mean a LISTEN per tenant on every instance, which
 * does not scale and cannot be unsubscribed cheaply.
 *
 * The payload carries IDS ONLY. Postgres notifications are not tenant-scoped and
 * cap at 8000 bytes, so message text and customer names never travel this way —
 * the client re-reads through the authorised endpoint instead.
 */
export const NOTIFY_INBOX_CHANNEL = 'wouchh_inbox_changed';

/** Keeps a stream alive through proxies that drop an idle connection. */
export const SSE_HEARTBEAT_MS = 25_000;

/** Per-enterprise cap, so one tenant cannot pin every connection on an instance. */
export const SSE_MAX_STREAMS_PER_ENTERPRISE = 20;

/**
 * How wide one row of the rate-limit monitor is.
 *
 * A minute is chosen so the dashboard has something moving to show while
 * somebody watches it, and because a bucket is only written for a scope we
 * ACTUALLY CALLED in that minute — a quiet business writes nothing. So the row
 * rate is proportional to real traffic rather than to how many businesses have
 * connected.
 */
export const META_USAGE_BUCKET_MS = 60 * 1000;

/**
 * How often accumulated usage reaches the database.
 *
 * Readings are aggregated in memory and flushed on this timer rather than
 * written per call: recording an observation must never add a round trip to a
 * Graph call, and a burst of two hundred calls in a minute should cost one
 * UPSERT, not two hundred.
 *
 * The cost of the delay is that the dashboard is up to this far behind, which
 * is why it is well under the poll interval a browser would use.
 */
export const META_USAGE_FLUSH_MS = 15 * 1000;

/**
 * The most in-memory buckets one process will hold before it starts discarding.
 *
 * A bound, not a target — the normal resident set is the number of scopes
 * called since the last flush, which is small. This exists so that a database
 * that is refusing writes degrades into losing MONITORING data rather than into
 * an out-of-memory kill of a process that is otherwise serving traffic fine.
 */
export const META_USAGE_MAX_PENDING_BUCKETS = 10_000;

/**
 * How long usage history is kept.
 *
 * Longer than the widest window Meta meters over (24 hours for Instagram,
 * Messenger and Pages), so a full window is always visible plus a day to
 * compare it against. Beyond that it is a chart nobody reads, and this table
 * has the highest natural row rate of anything added for observability.
 */
export const META_USAGE_RETENTION_MS = 48 * 60 * 60 * 1000;

/**
 * How long a platform-channel-id -> channel lookup is trusted.
 *
 * The map from Meta's ids to our channels changes only when a business connects
 * or disconnects, so this is cached to keep a query off the path of every Graph
 * response. A newly connected channel is therefore unattributed for at most
 * this long, and shows up under its Meta id until the cache turns over.
 */
export const META_USAGE_SCOPE_CACHE_MS = 5 * 60 * 1000;

/**
 * The percentage at which Meta starts refusing calls.
 *
 * Meta's documentation is explicit that every figure in both usage headers is a
 * whole-number PERCENTAGE of the allowance, not a count of calls — verified
 * live: six consecutive calls to one edge left `call_count` at 1, not 6.
 */
export const META_USAGE_THROTTLE_PCT = 100;

/**
 * Where the dashboard turns amber.
 *
 * Deliberately far below the limit. Meta's own guidance is that continuing to
 * call once throttled EXTENDS the block, so the useful warning is the one that
 * arrives with enough headroom to slow down voluntarily.
 */
export const META_USAGE_WARN_PCT = 75;

/**
 * The default span of the rate-limit chart.
 *
 * Three hours: long enough to show the shape of a backfill against the app
 * pool's one-hour window, short enough that the default view is not mostly
 * empty on a quiet deployment.
 */
export const DEFAULT_RATE_LIMIT_WINDOW_MINUTES = 3 * 60;

/**
 * The default row cap on one history request.
 *
 * At one bucket per pool per minute, this is three hours of a dozen pools with
 * room to spare. The schema allows more; this is what a client gets for asking
 * for nothing.
 */
export const DEFAULT_RATE_LIMIT_POINTS = 2000;

/**
 * The most pools the rate-limit console returns in one read.
 *
 * Every other listing in this service is bounded and this one was not — it is a
 * row per business per product, so it grows with the customer base while the
 * screen that reads it polls every twenty seconds. Generous enough that a real
 * deployment never reaches it, and present so that one cannot discover the
 * limit by falling over it.
 */
export const MAX_MONITORED_POOLS = 500;

/**
 * How long an ambiguous send is left alone before the read-back looks for it.
 *
 * A comment Meta accepted is not necessarily on the comments edge the instant
 * the HTTP call dies. Reading back too early would find nothing and conclude
 * the send was lost — the one conclusion that invites an agent to post the
 * same reply twice, which is the exact duplicate the ambiguous branch exists
 * to prevent. Two minutes costs an agent nothing: the reply already shows as
 * failed, and the correction is what is being bought.
 */
export const SEND_READ_BACK_DELAY_MS = 2 * 60 * 1000;

/**
 * How long a read-back keeps trying before giving up as `unknown`.
 *
 * Bounded by Instagram, not by us: the comments edge returns a recent window,
 * so past it "not found" stops being evidence of anything. A send that ages out
 * is recorded as UNKNOWN rather than lost, because the two are different facts
 * and only one of them is safe to act on.
 */
export const SEND_READ_BACK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How far a candidate comment's timestamp may sit from the failed attempt.
 *
 * The match is text plus time, because text alone is not unique — an agent who
 * sends "Thanks!" twice in a day would otherwise have the second send matched
 * against the first one's comment. Ten minutes is wide enough for clock skew
 * between Meta's timestamp and ours and narrow enough that two genuinely
 * separate sends of the same words do not collide.
 */
export const SEND_READ_BACK_MATCH_WINDOW_MS = 10 * 60 * 1000;

/** How often ambiguous sends are read back. */
export const SEND_RECONCILE_CRON = '*/10 * * * *';

/** A ceiling per run, so one sweep costs a bounded number of Graph calls. */
export const SEND_RECONCILE_BATCH = 25;

/**
 * How many times a dead-lettered moderation send may be replayed by hand.
 *
 * A replay is a human decision, so this is not the automatic retry budget —
 * that one already gave up. It is a stop on a button somebody can keep
 * pressing: a hide that Graph refuses will refuse every time, and the tenth
 * attempt tells nobody anything the third did not.
 */
export const MAX_MODERATION_REPLAYS = 3;
