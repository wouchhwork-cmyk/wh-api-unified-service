/**
 * Reading a Meta messaging entry: which message it concerns, and what it does
 * to it.
 *
 * A MODULE OF ITS OWN, not helpers inside the webhook service. They are pure
 * functions over a payload and the rules they encode are the sort that need
 * testing directly — and importing them from the service drags in the whole
 * Nest dependency graph to do it.
 */

/** Facebook's feed discriminator: comment, status, photo, video, share, like. */
export function readItem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = (value as { item?: unknown }).item;
  return typeof item === 'string' ? item : null;
}

export function extractId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['comment_id', 'post_id', 'media_id', 'id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return null;
}

export function extractMessageId(message: Record<string, unknown>): string | null {
  /*
   * The message this event is ABOUT, which for half of them is not the message
   * itself. A reaction, a read receipt and an edit each name another message's
   * mid; only reading `message.mid` left them with no platform id at all and a
   * dedup key hashed from the whole payload.
   */
  for (const key of ['message', 'reaction', 'read', 'message_edit']) {
    const inner = message[key];
    if (typeof inner === 'object' && inner !== null) {
      const mid = (inner as Record<string, unknown>).mid;
      if (typeof mid === 'string' && mid) return mid;
    }
  }
  return null;
}

/**
 * What this messaging event DOES to the message it names.
 *
 * Without it an unsend collides with the message it deletes: both carry the
 * same mid, so both produced the same dedup key and the unsend was rejected as
 * a duplicate of the thing it was trying to change — silently, since a
 * duplicate is a normal outcome. Observed on live traffic.
 *
 * The timestamp is part of a reaction's verb because a reaction can be put on,
 * taken off, and put on again: without it the third event collides with the
 * first. Meta's retries repeat the timestamp, so dedup still catches those.
 */
export function extractMessagingVerb(message: Record<string, unknown>): string | null {
  const at = typeof message.timestamp === 'number' ? String(message.timestamp) : '';

  const reaction = message.reaction;
  if (typeof reaction === 'object' && reaction !== null) {
    const action = (reaction as Record<string, unknown>).action;
    return `reaction:${typeof action === 'string' ? action : 'react'}:${at}`;
  }

  if (typeof message.read === 'object' && message.read !== null) return `read:${at}`;
  if (typeof message.message_edit === 'object' && message.message_edit !== null) return 'edit';

  const inner = message.message;
  if (typeof inner === 'object' && inner !== null) {
    // An unsend is not the message; it is what happened to it.
    if ((inner as Record<string, unknown>).is_deleted === true) return 'unsend';
  }
  return null;
}
