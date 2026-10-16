import { createHash } from 'node:crypto';
import type { InboundEventType, OutboundEventType, Platform } from '@/shared/enums';

/**
 * Dedup keys (schema.md "The dedup_key scheme").
 *
 * THE RULE THAT MATTERS: backfill and webhooks must produce IDENTICAL keys for
 * the same item. These functions therefore depend only on the item's own
 * identity and never on the route it arrived by. If a backfill invented its own
 * event type, every item that overlapped a live webhook would silently
 * duplicate — and that overlap is the likeliest source of duplicates in this
 * product, because a customer comments while the initial sync is still walking
 * that post.
 */
/**
 * The column is finite and platform ids are not.
 *
 * An Instagram message id is about 170 characters, so
 * `instagram:direct_message:<mid>` already sat at 196 of the 200 available —
 * four to spare, and nothing said so. Adding a verb to distinguish a reaction
 * from the message it is about pushed every one of those events over, and the
 * insert failed while the webhook still answered 200: reactions, unsends and
 * read receipts were accepted from Meta and quietly dropped.
 *
 * Past this length the identity is hashed rather than truncated. Truncating
 * would silently merge two different events whose ids share a prefix, which is
 * exactly what Instagram's ids do — they differ in the last few characters.
 */
const MAX_IDENTITY_CHARS = 400;

function boundIdentity(identity: string): string {
  if (identity.length <= MAX_IDENTITY_CHARS) return identity;
  return `h:${createHash('sha256').update(identity).digest('hex')}`;
}

export function inboundDedupKey(
  platform: Platform,
  eventType: InboundEventType,
  platformEventId: string,
): string {
  return `${platform}:${eventType}:${boundIdentity(platformEventId)}`;
}

/**
 * For events the platform gives no id for — a "post metrics changed" ping, say.
 * Collapsing identical payloads is CORRECT there: two identical notifications
 * mean the same refresh, and debouncing them is the desired behaviour.
 */
export function inboundDedupKeyFromPayload(
  platform: Platform,
  eventType: InboundEventType,
  canonicalPayload: unknown,
): string {
  const hash = createHash('sha256').update(stableStringify(canonicalPayload)).digest('hex');
  return `${platform}:${eventType}:h:${hash.slice(0, 48)}`;
}

/**
 * Outbound keys derive from the DOMAIN ROW THAT CAUSED THE SEND, not from its
 * result and not from its payload.
 *
 * Two reasons. An outbound send has no platform id until after it succeeds, so
 * the inbound scheme cannot apply. And hashing the payload would collide two
 * legitimate identical replies — an agent saying "Thanks!" twice in one thread
 * is not a duplicate.
 *
 * A projector or API retry re-enqueues the same cause and collides; a genuine
 * user resend creates a new messages row and therefore a new key.
 */
export function outboundDedupKey(
  platform: Platform,
  eventType: OutboundEventType,
  sourceTable: string,
  sourceRowId: number | string,
): string {
  return `${platform}:${eventType}:${sourceTable}:${sourceRowId}`;
}

/** Key order must not change the hash, or the same payload could hash twice. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
