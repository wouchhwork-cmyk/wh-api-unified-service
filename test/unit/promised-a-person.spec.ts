import { describe, expect, it } from 'vitest';
import { promisedAPerson } from '@/modules/inbox/promised-a-person';

/**
 * Catching a promise the system did not record.
 *
 * FROM A LIVE FAILURE. "Hello! A colleague will be with you shortly to help
 * sort this out." went out with `handoff` null — the customer told somebody
 * was coming, the system recording that nobody was needed, and no flag in
 * any inbox. Nobody was ever going to arrive.
 *
 * THE FALSE POSITIVES MATTER AS MUCH AS THE HITS. A flag raised on a reply
 * that merely mentions colleagues is a flag somebody learns to ignore, and
 * then the real ones go unread too.
 */
describe('spotting a promise of a person', () => {
  const promises = [
    'Hello! A colleague will be with you shortly to help sort this out.',
    'A colleague will take over and help sort this out for you shortly.',
    'I am connecting you with a colleague who will be able to help.',
    'One of our team members will get back to you today.',
    'Someone from our team will contact you shortly.',
    'A member of our team will be with you soon.',
    'I will escalate this to a colleague.',
    'This will be passed to one of our agents.',
    'A human will reach out to you about this.',
  ];

  promises.forEach((reply) => {
    it(`reads as a promise: "${reply.slice(0, 44)}…"`, () => {
      expect(promisedAPerson(reply)).toBe(true);
    });
  });

  const notPromises = [
    'Your mobile number is +918888888888.',
    'My colleagues handle refunds, so I can tell you the policy.',
    'I can help you with that myself.',
    'We are open from nine until nine every day.',
    'Thanks for letting us know — I have updated your email.',
    'I cannot see an order under that number.',
    'Would you like me to pass this to a colleague?',
    '',
  ];

  notPromises.forEach((reply) => {
    it(`is not a promise: "${reply.slice(0, 44) || '(empty)'}…"`, () => {
      expect(promisedAPerson(reply)).toBe(false);
    });
  });

  it('ignores null and undefined rather than throwing', () => {
    expect(promisedAPerson(null)).toBe(false);
    expect(promisedAPerson(undefined)).toBe(false);
  });
});
