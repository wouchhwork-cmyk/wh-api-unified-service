import { describe, expect, it } from 'vitest';
import { decodeKeysetCursor, encodeKeysetCursor } from '@/shared/utils/keyset-cursor';

/**
 * The cursor is a WIRE FORMAT, and a client can send anything at all in it.
 *
 * This existed three times — inbox, catalogue, platform console — and every copy
 * passed `new Date(parsed.t)` straight through, so a caller could turn a listing
 * into a 500 with four characters of made-up JSON. The interesting cases here
 * are all hostile input, not round trips.
 */
describe('keyset cursor', () => {
  const AT = new Date('2026-03-04T05:06:07.008Z');

  it('round trips a timestamp and an id', () => {
    expect(decodeKeysetCursor(encodeKeysetCursor(AT, 42))).toEqual({ at: AT, id: 42 });
  });

  it('round trips a null sort key', () => {
    // Legitimate: the row sorted last under NULLS LAST, and the next page has
    // to resume from it by id alone.
    expect(decodeKeysetCursor(encodeKeysetCursor(null, 7))).toEqual({ at: null, id: 7 });
  });

  it.each([
    ['absent', null],
    ['empty', ''],
    ['not json', Buffer.from('nope').toString('base64url')],
    ['an array', Buffer.from('[1,2]').toString('base64url')],
  ])('treats a %s cursor as no cursor', (_label, cursor) => {
    expect(decodeKeysetCursor(cursor)).toBeNull();
  });

  it.each([
    ['an unparseable timestamp', '{"t":"nope","i":1}'],
    ['a numeric timestamp', '{"t":1700000000,"i":1}'],
    ['a missing id', '{"t":null}'],
    ['a non-numeric id', '{"t":null,"i":"1"}'],
    ['a fractional id', '{"t":null,"i":1.5}'],
    ['a negative id', '{"t":null,"i":-1}'],
    ['an unsafe id', '{"t":null,"i":1e21}'],
  ])('rejects %s rather than binding it into a query', (_label, json) => {
    expect(decodeKeysetCursor(Buffer.from(json).toString('base64url'))).toBeNull();
  });

  it('does not leak the sort key in a readable form', () => {
    // Opaque is the contract: clients must not build one by hand, or the sort
    // key becomes part of the API.
    const encoded = encodeKeysetCursor(AT, 42);
    expect(encoded).not.toContain('2026');
    expect(encoded).not.toMatch(/[+/=]/u);
  });
});
