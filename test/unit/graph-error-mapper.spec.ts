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

describe('business use case throttling is a rate limit, not a dead end', () => {
  /**
   * WHAT INSTAGRAM AND MESSENGER ACTUALLY SEND. The mapper knew the legacy
   * platform codes — 4, 17, 32, 613 — and none of the BUC ones, so the limit
   * our calls really hit fell through to the bottom of the function and came
   * back `retryable: false`.
   *
   * That is the single most retryable failure there is: wait and it clears. It
   * was dead-lettering work permanently, while the client read
   * `estimated_time_to_regain_access` off the same response and threw the job
   * away anyway.
   *
   * Verified on the wire 21 Sep: Meta meters per business AND per product — the
   * same thread reports `type: instagram` under one business id and
   * `type: messenger` under another, so the pools empty independently and
   * either code can arrive on its own.
   */
  const throttle = (code: number, subcode: number | null = 2446079): GraphApiError =>
    new GraphApiError(400, code, subcode, 'OAuthException', null, 'throttled', 12);

  it('retries an Instagram throttle', () => {
    const mapped = mapGraphError(throttle(80002));
    expect(mapped.code).toBe(ErrorCode.UpstreamRateLimited);
    expect(mapped.retryable).toBe(true);
  });

  it('retries a Messenger throttle, which is a separate pool', () => {
    const mapped = mapGraphError(throttle(80006));
    expect(mapped.code).toBe(ErrorCode.UpstreamRateLimited);
    expect(mapped.retryable).toBe(true);
  });

  it('retries a Page throttle', () => {
    expect(mapGraphError(throttle(80001)).retryable).toBe(true);
  });

  it('recognises a bucket we have not met yet, by its subcode', () => {
    // Meta adds use cases. Matching the subcode too means the next one is a
    // rate limit on arrival rather than after an outage teaches us the number.
    const mapped = mapGraphError(throttle(99_999));
    expect(mapped.code).toBe(ErrorCode.UpstreamRateLimited);
    expect(mapped.retryable).toBe(true);
  });

  it('never makes a dead token look retryable', () => {
    /*
     * The boundary worth guarding. Re-auth is checked BEFORE throttling, and
     * widening the throttle branch must not swallow a token failure — retrying
     * that forever would spend quota to be told the same thing.
     */
    const expired = new GraphApiError(400, 190, 463, 'OAuthException', null, 'expired');
    const mapped = mapGraphError(expired);
    expect(mapped.code).toBe(ErrorCode.ChannelReauthRequired);
    expect(mapped.retryable).toBe(false);
    expect(mapped.requiresReauth).toBe(true);
  });

  it('carries the wait Meta named, so the retry is not a guess', () => {
    // estimated_time_to_regain_access, in MINUTES, read off the same response.
    expect(throttle(80002).retryAfterMinutes).toBe(12);
  });
});
