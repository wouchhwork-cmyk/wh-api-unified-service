import { describe, expect, it } from 'vitest';
import { GraphApiError } from '@/modules/connections/graph/graph-api.error';
import { mapGraphError } from '@/modules/connections/graph/graph-error.mapper';
import { ErrorCode } from '@/shared/errors';

/**
 * What a Graph failure means for what we do next.
 *
 * These assertions exist because the classification decides behaviour, not just
 * wording: `retryable` controls whether a send is retried or dead-lettered, and
 * `requiresReauth` decides whether a business is asked to reconnect. Getting one
 * wrong either burns a retry budget on something permanent or gives up on
 * something transient.
 */
const error = (code: number | null, message = 'boom', subcode: number | null = null) =>
  new GraphApiError(400, code, subcode, 'OAuthException', null, message);

describe('mapGraphError', () => {
  it('treats a missing app capability as a permission problem, not an outage', () => {
    // Regression: code 3 was unmapped and surfaced as UPSTREAM_UNAVAILABLE,
    // which reads as "Meta is down" for something only an app change can fix.
    const mapped = mapGraphError(error(3, 'Application does not have the capability'));

    expect(mapped.code).toBe(ErrorCode.PermissionDenied);
    expect(mapped.retryable).toBe(false);
    expect(mapped.requiresReauth).toBe(false);
  });

  it.each([4, 17, 32, 613])('treats %i as a retryable rate limit', (code) => {
    const mapped = mapGraphError(error(code));

    expect(mapped.code).toBe(ErrorCode.UpstreamRateLimited);
    expect(mapped.retryable).toBe(true);
    // A rate limit must never trigger a reconnect prompt: the token is fine.
    expect(mapped.requiresReauth).toBe(false);
  });

  it('asks for a reconnect on a dead token', () => {
    const mapped = mapGraphError(error(190));

    expect(mapped.requiresReauth).toBe(true);
    expect(mapped.retryable).toBe(false);
  });

  it('retries a temporary graph failure', () => {
    const mapped = mapGraphError(error(2));
    expect(mapped.retryable).toBe(true);
  });

  it('retries a transport failure, where the outcome was never learned', () => {
    const mapped = mapGraphError(
      GraphApiError.fromTransport(new Error('socket hang up'), 'timeout'),
    );
    expect(mapped.retryable).toBe(true);
  });

  it('does not retry an unrecognised failure', () => {
    // Unknown means unknown: retrying forever is worse than surfacing it.
    const mapped = mapGraphError(error(99_999));
    expect(mapped.retryable).toBe(false);
  });
});
