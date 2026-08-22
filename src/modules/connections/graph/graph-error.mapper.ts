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
  ApplicationRateLimit: 4,
  UserRequestLimit: 17,
  PageRateLimit: 32,
  CustomRateLimit: 613,
  /** Temporary Graph failure — retryable. */
  TemporaryIssue: 2,
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

  if (
    error.code === META.ApplicationRateLimit ||
    error.code === META.UserRequestLimit ||
    error.code === META.PageRateLimit ||
    error.code === META.CustomRateLimit
  ) {
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
