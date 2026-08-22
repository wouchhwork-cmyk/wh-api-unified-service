import { describe, expect, it } from 'vitest';
import { resolveWebhookVerifyToken } from '@/modules/connections/webhook-verify-token';

/**
 * The verify token is derived rather than invented, so the derivation has to be
 * stable: if it changed between restarts, the value sitting in the Meta dashboard
 * would stop matching and webhook delivery would fail with nothing to explain it.
 */
describe('the webhook verify token', () => {
  const secret = 'an-app-secret-from-meta';

  it('prefers an explicitly configured token', () => {
    // An environment that already has one in the Meta dashboard must keep it.
    expect(resolveWebhookVerifyToken('already-configured', secret)).toBe('already-configured');
  });

  it('derives one from the app secret when none is configured', () => {
    const derived = resolveWebhookVerifyToken('', secret);
    expect(derived).toMatch(/^[0-9a-f]{32}$/);
  });

  it('derives the SAME token every time', () => {
    // The whole point: paste it into Meta once and it keeps working.
    expect(resolveWebhookVerifyToken('', secret)).toBe(resolveWebhookVerifyToken('', secret));
  });

  it('derives a different token per app secret', () => {
    expect(resolveWebhookVerifyToken('', secret)).not.toBe(
      resolveWebhookVerifyToken('', 'a-different-app-secret'),
    );
  });

  it('never leaks the app secret it was derived from', () => {
    const derived = resolveWebhookVerifyToken('', secret) ?? '';
    expect(derived).not.toContain(secret);
    expect(secret).not.toContain(derived);
  });

  it('returns null when there is nothing to derive from', () => {
    // Nothing to compare against, so the handshake must refuse rather than
    // accept an empty token — which would make the endpoint open to anyone.
    expect(resolveWebhookVerifyToken('', '')).toBeNull();
  });
});
