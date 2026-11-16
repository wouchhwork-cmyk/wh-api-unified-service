import { describe, expect, it } from 'vitest';
import { replyCapFor, shapeReply } from '@/modules/inbox/reply-format';
import { CHATBOT_PUBLIC_REPLY_CHARS } from '@/shared/constants';
import { ConversationKind } from '@/shared/enums';

/**
 * What actually arrives on somebody's phone.
 *
 * Instagram and Facebook render a direct message as plain text, so every one
 * of these is something a customer would have READ: the asterisks, the
 * hyphens, the heading. The instruction already asks the model not to; this
 * is the half that does not depend on it having listened.
 */
describe('shaping a reply', () => {
  it('removes the emphasis a model reaches for', () => {
    expect(shapeReply('We have **three** in stock', 900)).toBe('We have three in stock');
    expect(shapeReply('That is __important__', 900)).toBe('That is important');
    expect(shapeReply('It is *quite* new', 900)).toBe('It is quite new');
  });

  it('leaves arithmetic and handles alone', () => {
    expect(shapeReply('2 * 3 is six', 900)).toBe('2 * 3 is six');
    expect(shapeReply('find us at @acme_store_pune', 900)).toBe('find us at @acme_store_pune');
  });

  it('turns a list back into lines a person might have typed', () => {
    expect(shapeReply('Colours:\n- blue\n- red\n3. green', 900)).toBe('Colours:\nblue\nred\ngreen');
  });

  it('drops headings and quote markers, which have no meaning in a DM', () => {
    expect(shapeReply('## Delivery\nTwo days', 900)).toBe('Delivery\nTwo days');
    expect(shapeReply('> you asked\nyes', 900)).toBe('you asked\nyes');
  });

  it('keeps the link when it unwraps one', () => {
    expect(shapeReply('Order here: [Shop](https://acme.test/shop)', 900)).toBe(
      'Order here: Shop (https://acme.test/shop)',
    );
  });

  it('stops at a sentence rather than mid-word', () => {
    const long = `${'Yes we do. '.repeat(40)}And then some more words after it`;
    const shaped = shapeReply(long, 100);

    expect(shaped.length).toBeLessThanOrEqual(100);
    expect(shaped.endsWith('.')).toBe(true);
  });

  it('marks a cut that had nowhere good to stop', () => {
    const shaped = shapeReply('supercalifragilistic '.repeat(20), 50);

    expect(shaped.endsWith('…')).toBe(true);
    expect(shaped).not.toContain('supercalifragilisti…');
  });

  it('leaves a short reply exactly as written', () => {
    expect(shapeReply('Yes, open till 9 today.', 900)).toBe('Yes, open till 9 today.');
  });
});

describe('how long a reply may be', () => {
  it('is shorter in public than in private', () => {
    expect(replyCapFor(ConversationKind.CommentThread)).toBe(CHATBOT_PUBLIC_REPLY_CHARS);
    expect(replyCapFor(ConversationKind.Mention)).toBe(CHATBOT_PUBLIC_REPLY_CHARS);
    expect(replyCapFor(ConversationKind.DirectMessage)).toBeGreaterThan(CHATBOT_PUBLIC_REPLY_CHARS);
  });
});
