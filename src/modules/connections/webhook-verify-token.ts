import { createHmac } from 'node:crypto';

/**
 * The string Meta echoes back during the one-time webhook handshake.
 *
 * DERIVED, not invented. Meta's handshake requires both sides to know the same
 * value, but nothing requires a person to make one up, paste it into two places
 * and remember which environment got which. Ask the service for its token and
 * paste that into the Meta dashboard.
 *
 * Derived from the app secret because that is the right thing to be coupled to:
 * both belong to the same Meta app, so rotating the app secret invalidates the
 * webhook configuration — which is correct, since rotating it means revisiting
 * that app's settings anyway. Deriving from, say, the JWT secret would mean an
 * unrelated rotation silently breaking webhook delivery.
 *
 * An explicit META_WEBHOOK_VERIFY_TOKEN always wins, for an environment that
 * already has one configured in Meta.
 *
 * This is not the security boundary. Every delivery is authenticated by an
 * HMAC-SHA256 over the RAW body under the app secret; the verify token only
 * guards the subscription handshake, which is why deriving it is safe.
 */
const DERIVATION_LABEL = 'wouchh:meta-webhook-verify:v1';

export function resolveWebhookVerifyToken(configured: string, appSecret: string): string | null {
  if (configured) return configured;
  if (!appSecret) return null;

  // Truncated to 32 hex characters: comfortably past Meta's limits and past
  // guessing, without being unwieldy to paste.
  return createHmac('sha256', appSecret).update(DERIVATION_LABEL).digest('hex').slice(0, 32);
}
