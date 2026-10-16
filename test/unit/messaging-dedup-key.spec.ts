import { describe, expect, it } from 'vitest';
import { composeDedupKey } from '@/modules/connections/meta-webhook.service';
import { extractMessageId, extractMessagingVerb } from '@/modules/connections/messaging-event';
import { InboundEventType, Platform } from '@/shared/enums';

/**
 * Telling a message apart from the things that happen TO it.
 *
 * A reaction, a read receipt, an edit and an unsend all name the message they
 * concern, so every one of them carries the same mid. The key was built from
 * the id alone, which meant an unsend collided with the very message it deletes
 * and was dropped as a duplicate — silently, because a duplicate is a normal
 * outcome and nothing logs one. Observed on live traffic: the reaction landed
 * and the unsend vanished.
 */
describe('the dedup key for a messaging event', () => {
  const MID = 'aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlE';
  const key = (message: Record<string, unknown>): string =>
    composeDedupKey(
      Platform.Instagram,
      InboundEventType.DirectMessage,
      extractMessageId(message),
      extractMessagingVerb(message),
      message,
    );

  const message = { timestamp: 1, message: { mid: MID, text: 'hello' } };
  const unsend = { timestamp: 2, message: { mid: MID, is_deleted: true } };
  const react = { timestamp: 3, reaction: { mid: MID, action: 'react', emoji: '❤️' } };
  const unreact = { timestamp: 4, reaction: { mid: MID, action: 'unreact' } };
  const read = { timestamp: 5, read: { mid: MID } };
  const edited = { timestamp: 6, message_edit: { mid: MID, num_edit: 0 } };

  it('gives every kind of event about one message a different key', () => {
    const keys = [message, unsend, react, unreact, read, edited].map(key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not let an unsend collide with the message it deletes', () => {
    // The exact failure seen live: the unsend never reached the ledger.
    expect(key(unsend)).not.toBe(key(message));
    expect(key(unsend)).toContain('unsend');
  });

  it('still collapses a redelivery of the same event', () => {
    // Meta retries with an identical payload, timestamp included, and those
    // must still be recognised as one event.
    expect(key(react)).toBe(key({ ...react }));
    expect(key(message)).toBe(key({ ...message }));
  });

  it('lets a reaction be put on, taken off, and put on again', () => {
    // Without the timestamp in the verb the third event collides with the
    // first, and the customer's reaction silently fails to come back.
    const again = { timestamp: 7, reaction: { mid: MID, action: 'react', emoji: '❤️' } };
    expect(key(again)).not.toBe(key(react));
  });

  it('finds the message id wherever the event carries it', () => {
    // Reading only `message.mid` left a reaction, a read and an edit with no
    // platform id at all, and a key hashed from the whole payload.
    expect(extractMessageId(react)).toBe(MID);
    expect(extractMessageId(read)).toBe(MID);
    expect(extractMessageId(edited)).toBe(MID);
    expect(extractMessageId(message)).toBe(MID);
  });

  it('gives an ordinary message no verb at all', () => {
    expect(extractMessagingVerb(message)).toBeNull();
  });
});
