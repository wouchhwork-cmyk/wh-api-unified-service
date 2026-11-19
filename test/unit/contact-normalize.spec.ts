import { describe, expect, it } from 'vitest';
import { cleanContact } from '@/shared/utils/normalize';
import { IdentifierKind } from '@/shared/enums';

/**
 * Making a contact detail fit to store.
 *
 * THE RULE THESE EXIST TO PROTECT: the country of a phone number is NEVER
 * guessed. It comes from the number, from somebody who said it, or from what
 * the business declared about itself — and where none of those answer, the
 * right outcome is a question, not a best effort.
 *
 * It is worth being blunt about why. A number read as the wrong country is
 * wrong, looks right, and gets dialled. There is no version of guessing that
 * fails loudly, which is exactly what makes it worth a test file.
 */
const mobile = (value: string, over: Record<string, unknown> = {}) =>
  cleanContact({ kind: IdentifierKind.Mobile, value, ...over });

describe('where the country of a number comes from', () => {
  it('takes it from the number when it was written with a +', () => {
    // Explicit, and true wherever the business happens to trade.
    const result = mobile('+44 7400 123456', { operatesIn: ['IN'] });

    expect(result.ok && result.contact.canonical).toBe('+447400123456');
    expect(result.ok && result.contact.mobile?.countryCode).toBe('GB');
  });

  it('takes a stated country over the one the business declared', () => {
    const result = mobile('07400 123456', { stated: 'GB', operatesIn: ['IN'] });

    expect(result.ok && result.contact.canonical).toBe('+447400123456');
  });

  it('uses the business’s country when it has exactly one', () => {
    // A declaration, not a guess. This is the ordinary case and it asks
    // nobody anything.
    const result = mobile('8888 8888 88', { operatesIn: ['IN'] });

    expect(result.ok && result.contact.canonical).toBe('+918888888888');
  });

  it('asks rather than picks when the business declared none', () => {
    const result = mobile('8888888888', { operatesIn: [] });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.problem).toBe('needs_country');
  });

  it('asks rather than picks when the business declared several', () => {
    // Two countries is a question, not a default. Picking the first would
    // be a guess with a tidy justification.
    const result = mobile('8888888888', { operatesIn: ['IN', 'GB'] });

    expect(!result.ok && result.problem).toBe('needs_country');
  });

  it('offers the declared countries as the answers worth giving', () => {
    // The point of distinguishing this from "unreadable": somebody can act
    // on it, and these are what to put in front of them.
    const result = mobile('8888888888', { operatesIn: ['IN', 'GB'] });

    expect(!result.ok && result.choices).toEqual(['IN', 'GB']);
  });

  it('still reads an international number when nothing was declared', () => {
    // The + carries the country, so there is nothing left to ask about.
    const result = mobile('+918888888888', { operatesIn: [] });

    expect(result.ok && result.contact.canonical).toBe('+918888888888');
  });

  it('ignores a country written as a word rather than a code', () => {
    // A model given a free-text field will eventually write "India"; a form
    // will eventually send "+91". Feeding either to the parser as a region
    // is how a valid number silently becomes a null.
    const result = mobile('9876543210', { stated: 'India', operatesIn: ['IN'] });

    expect(result.ok && result.contact.canonical).toBe('+919876543210');
  });

  it('accepts a country stated in lower case', () => {
    const result = mobile('07400 123456', { stated: 'gb', operatesIn: ['IN'] });

    expect(result.ok && result.contact.canonical).toBe('+447400123456');
  });

  it('ignores junk in the declared list rather than treating it as a country', () => {
    // One bad entry must not turn a one-country business into a two-country
    // one, which would start asking questions nobody can answer.
    const result = mobile('8888888888', { operatesIn: ['IN', '', 'nonsense'] });

    expect(result.ok && result.contact.canonical).toBe('+918888888888');
  });
});

describe('a number that is not one', () => {
  it('is refused rather than stored', () => {
    // Worse than no record: a number somebody will eventually ring.
    expect(mobile('12345', { operatesIn: ['IN'] }).ok).toBe(false);
  });

  it('is told apart from a number missing its country', () => {
    const result = mobile('12345', { operatesIn: ['IN'] });

    expect(!result.ok && result.problem).toBe('unreadable');
  });

  it('is judged per country, which is the whole reason the country is never guessed', () => {
    /*
     * THE DANGER, DEMONSTRATED. "07400 123456" is a valid mobile read as GB
     * and ALSO a valid mobile read as IN — two different, real, reachable
     * people. Validation cannot catch the mistake because neither result is
     * invalid. Nothing downstream can catch it either.
     *
     * So the country is never inferred from the digits, and a wrong country
     * is not a validation failure, it is a wrong person. This is the test
     * that says why the rule is a rule.
     */
    const asBritish = mobile('07400 123456', { stated: 'GB' });
    const asIndian = mobile('07400 123456', { stated: 'IN' });

    expect(asBritish.ok && asBritish.contact.canonical).toBe('+447400123456');
    expect(asIndian.ok && asIndian.contact.canonical).toBe('+917400123456');
  });

  it('is refused when the digits form no number in the declared country', () => {
    // The per-country rules still do work: they are what keeps a declared
    // country from turning any string of digits into a stored number.
    expect(mobile('00000', { operatesIn: ['IN'] }).ok).toBe(false);
  });

  it('decomposes a good one into the columns that index it', () => {
    const result = mobile('8888888888', { operatesIn: ['IN'] });

    expect(result.ok && result.contact.mobile).toEqual({
      countryCode: 'IN',
      callingCode: '91',
      nationalNumber: '8888888888',
    });
  });
});

describe('an email address', () => {
  const email = (value: string) => cleanContact({ kind: IdentifierKind.Email, value });

  it('is lower-cased and trimmed', () => {
    const result = email('  Aditya.Patil@Example.COM ');

    expect(result.ok && result.contact.canonical).toBe('aditya.patil@example.com');
  });

  it('carries no country, because there is nothing to decompose', () => {
    const result = email('a@b.com');

    expect(result.ok && result.contact.mobile).toBeUndefined();
  });

  it('is refused when it is not an address', () => {
    expect(email('aditya at example dot com').ok).toBe(false);
  });

  it('never asks for a country, whatever the business declared', () => {
    const result = cleanContact({
      kind: IdentifierKind.Email,
      value: 'nope',
      operatesIn: [],
    });

    expect(!result.ok && result.problem).toBe('unreadable');
  });
});
