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

/** Login throttling (schema.md §2). */
export const MAX_FAILED_LOGINS = 5;
export const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;
