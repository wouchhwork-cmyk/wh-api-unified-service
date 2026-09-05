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

/** How often the queue gauge is sampled and logged. */
export const QUEUE_GAUGE_INTERVAL_MS = 60_000;

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
