import { ErrorCode } from '@/shared/errors';
import { GraphApiError } from './graph-api.error';

/**
 * Meta error codes we act on. Taken from the socialLift implementation's
 * production experience plus Meta's documented values — the numbers are the only
 * reliable signal, because the message text changes and the HTTP status cannot
 * distinguish a dead token from a rate limit (both arrive as 400).
 */
const META = {
  /** The token is invalid or expired. Subcodes narrow the cause. */
  OAuthException: 190,
  /** Permission missing, or the messaging window has closed. */
  PermissionDenied: 10,
  /*
   * THE LEGACY PLATFORM LIMITS. Real, still issued, and NOT the ones our calls
   * actually hit.
   */
  ApplicationRateLimit: 4,
  UserRequestLimit: 17,
  PageRateLimit: 32,
  CustomRateLimit: 613,
  /*
   * BUSINESS USE CASE THROTTLING — what Instagram and Messenger really return,
   * and what this mapper had never heard of.
   *
   * Meta meters our calls per business and per product: an Instagram read and a
   * Messenger conversations read draw on SEPARATE pools, verified on the wire —
   * the same thread returns `type: instagram` under one business id and
   * `type: messenger` under another. When a pool runs out the error is one of
   * these codes, not code 4.
   *
   * Unmapped, they fell through to the bottom of this function and came back
   * `retryable: false`, so the single most retryable failure there is — wait a
   * while and it clears — was dead-lettering work permanently. Worse, the
   * client already reads `estimated_time_to_regain_access` off the response, so
   * we knew exactly how long to wait and threw the job away anyway.
   *
   * The quotas are a 24-hour rolling window for both:
   *   Instagram  calls = 4800 x impressions
   *   Messenger  calls = 200 x engaged users
   */
  InstagramBucThrottle: 80002,
  MessengerBucThrottle: 80006,
  PageBucThrottle: 80001,
  /**
   * THE WHOLE 800xx FAMILY IS A THROTTLE, and the range is checked rather than
   * the individual numbers.
   *
   * Meta's published table assigns these codes to use cases, but the table does
   * not agree with itself across sources: Instagram is documented as 80002 in
   * some renderings and 80005 in others, with LeadGen and Messenger shifting to
   * match. What every source DOES agree on is that the whole 800xx block is
   * business-use-case throttling and nothing else lives in it.
   *
   * So the range is the reliable signal and the exact number is not. Naming the
   * three above still earns its keep as documentation of what we have actually
   * seen; the range is what decides.
   */
  BucThrottleRangeStart: 80000,
  BucThrottleRangeEnd: 80099,
  /** Temporary Graph failure — retryable. */
  TemporaryIssue: 2,
  /**
   * The APP lacks the capability for this endpoint — not the user, and not the
   * token. Sending an Instagram DM without approved Instagram messaging access
   * returns this, and it is terminal until somebody changes the app's
   * configuration or completes App Review.
   */
  CapabilityMissing: 3,
} as const;

const SUBCODE = {
  /** Session expired. */
  TokenExpired: 463,
  /** Password changed, or the user removed the app. */
  TokenInvalidated: 467,
  /**
   * The 24-hour messaging window has closed. The single most valuable mapping
   * here: without it this reads as a generic permission failure and an agent is
   * told "you can't do that" instead of "this conversation has gone quiet".
   */
  MessagingWindowClosed: 2534022,
  /**
   * Business-use-case throttling, attached across products.
   *
   * Checked alongside the codes so a bucket we have not met yet — Meta adds
   * them — is still recognised as a rate limit rather than dead-lettered as an
   * unknown failure.
   */
  BucThrottled: 2446079,
} as const;

export interface MappedGraphError {
  readonly code: ErrorCode;
  /**
   * True when the credential itself is dead, so the caller must flag the
   * connection for re-auth rather than retrying. A live auth error BEATS the
   * calendar (schema.md §14): providers revoke early.
   */
  readonly requiresReauth: boolean;
  /** True when retrying later is reasonable. */
  readonly retryable: boolean;
}

/**
 * Whether Meta refused this call for rate limiting.
 *
 * Exported because two places need the SAME answer and must not drift: the
 * mapper, which decides whether the caller may retry, and the client, which
 * counts a refusal against the pool that refused it. A monitor that disagreed
 * with the retry logic about what a throttle is would be worse than no monitor,
 * because both would look right in isolation.
 */
export function isRateLimit(error: GraphApiError): boolean {
  if (
    error.code === META.ApplicationRateLimit ||
    error.code === META.UserRequestLimit ||
    error.code === META.PageRateLimit ||
    error.code === META.CustomRateLimit
  ) {
    return true;
  }

  // The business-use-case block, matched as a RANGE. See the constants.
  if (
    error.code !== null &&
    error.code >= META.BucThrottleRangeStart &&
    error.code <= META.BucThrottleRangeEnd
  ) {
    return true;
  }

  // Meta attaches this subcode to throttling across products, so it catches a
  // bucket outside the range rather than waiting for the next outage.
  return error.subcode === SUBCODE.BucThrottled;
}

export function mapGraphError(error: GraphApiError): MappedGraphError {
  // Transport failure: we never learned the outcome.
  if (error.httpStatus === 0) {
    return { code: ErrorCode.UpstreamUnavailable, requiresReauth: false, retryable: true };
  }

  if (error.subcode === SUBCODE.MessagingWindowClosed) {
    return { code: ErrorCode.MessagingWindowClosed, requiresReauth: false, retryable: false };
  }

  if (
    error.code === META.OAuthException ||
    error.subcode === SUBCODE.TokenExpired ||
    error.subcode === SUBCODE.TokenInvalidated
  ) {
    return { code: ErrorCode.ChannelReauthRequired, requiresReauth: true, retryable: false };
  }

  if (isRateLimit(error)) {
    return { code: ErrorCode.UpstreamRateLimited, requiresReauth: false, retryable: true };
  }

  if (error.code === META.TemporaryIssue || error.httpStatus >= 500) {
    return { code: ErrorCode.UpstreamUnavailable, requiresReauth: false, retryable: true };
  }

  /*
   * Code 10 is ambiguous: it covers both a missing permission and, on some
   * endpoints, the closed messaging window. The message is the only
   * discriminator Meta gives us, which is why it is checked here despite text
   * matching being fragile.
   */
  if (error.code === META.PermissionDenied) {
    if (/allowed window|24[- ]?hour/i.test(error.message)) {
      return { code: ErrorCode.MessagingWindowClosed, requiresReauth: false, retryable: false };
    }
    return { code: ErrorCode.PermissionDenied, requiresReauth: false, retryable: false };
  }

  /*
   * Mapped explicitly rather than left to the fallback below. Unmapped, code 3
   * arrived as UPSTREAM_UNAVAILABLE — "the platform is unavailable" — which sent
   * whoever read the log looking for a Meta outage, when the actual cause was a
   * capability this app was never granted. Same terminal outcome, honest reason.
   */
  if (error.code === META.CapabilityMissing) {
    return { code: ErrorCode.PermissionDenied, requiresReauth: false, retryable: false };
  }

  /*
   * A response we could not read. NOT retryable: a retry fetches the same
   * unexpected shape and fails identically, so it only spends quota on the way
   * to the same dead letter.
   *
   * Mapped explicitly for the reason code 3 is, a few lines up. The fallback
   * would call this UPSTREAM_UNAVAILABLE — "the platform is unavailable" —
   * which sends whoever reads the log hunting a Meta outage when what actually
   * happened is that Meta changed a shape and our schema caught it.
   */
  if (error.type === 'schema') {
    return { code: ErrorCode.UpstreamContractChanged, requiresReauth: false, retryable: false };
  }

  return { code: ErrorCode.UpstreamUnavailable, requiresReauth: false, retryable: false };
}

/**
 * Whether a failed SEND left us not knowing whether it took effect.
 *
 * This is the one duplicate a constraint cannot prevent (schema.md case 5): Meta
 * offers no idempotency token on these endpoints, so on an ambiguous failure the
 * rule is behavioural — read the thread back and look for our own content before
 * retrying. A clean 4xx is NOT ambiguous: nothing was created.
 */
export function isAmbiguousFailure(error: GraphApiError): boolean {
  /*
   * 429 is deliberately NOT ambiguous. Meta rejected the call at its edge, so
   * nothing was created and a retry cannot duplicate anything — treating it as
   * ambiguous made the relay cancel rate-limited sends permanently, which is the
   * opposite of what a rate limit asks for. Ambiguity means a timeout, a 5xx, or
   * a reset: the cases where the request may have been processed.
   */
  return error.httpStatus === 0 || error.httpStatus >= 500;
}
