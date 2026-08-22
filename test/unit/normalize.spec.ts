import { describe, expect, it } from 'vitest';
import {
  isValidEmail,
  maskEmail,
  maskMobile,
  normalizeEmail,
  normalizeMobile,
  normalizeSlug,
  normalizeText,
  isMobileConsistent,
} from '@/shared/utils/normalize';

describe('email normalization', () => {
  it('lower-cases the whole address, including the local part', () => {
    // Deliberate: RFC 5321 says the local part is case-sensitive, but no
    // provider treats it that way and users expect Bob@x.com to reach them.
    expect(normalizeEmail('Bob.Smith@Example.COM')).toBe('bob.smith@example.com');
  });

  it('strips surrounding whitespace and zero-width characters', () => {
    expect(normalizeEmail('  bob​@example.com  ')).toBe('bob@example.com');
  });

  it('accepts ordinary addresses', () => {
    for (const value of ['a@b.co', 'bob.smith+tag@sub.example.com', "o'brien@example.org"]) {
      expect(isValidEmail(normalizeEmail(value)), value).toBe(true);
    }
  });

  it('rejects addresses that would break the uniqueness key', () => {
    for (const value of [
      'no-at-sign',
      'two@@example.com',
      'bob@nodot',
      '.bob@example.com',
      'bob.@example.com',
      'bo..b@example.com',
      'a b@example.com',
      '@example.com',
    ]) {
      expect(isValidEmail(normalizeEmail(value)), value).toBe(false);
    }
  });

  it('masks an address without revealing it', () => {
    expect(maskEmail('bob.smith@example.com')).toBe('bo*******@example.com');
  });
});

describe('mobile normalization', () => {
  it('decomposes an E.164 number into the four stored values', () => {
    const result = normalizeMobile({ number: '+91 98765 43210' });
    expect(result).toEqual({
      canonical: '+919876543210',
      countryCode: 'IN',
      callingCode: '91',
      nationalNumber: '9876543210',
    });
  });

  it('accepts a national number when the country is explicit', () => {
    expect(normalizeMobile({ number: '9876543210', countryCode: 'IN' })?.canonical).toBe(
      '+919876543210',
    );
  });

  it('REJECTS a bare national number with no country', () => {
    // The whole point: an assumed country silently creates duplicate accounts
    // for the same human in different countries.
    expect(normalizeMobile({ number: '9876543210' })).toBeNull();
  });

  it('distinguishes countries that share a calling code', () => {
    const us = normalizeMobile({ number: '3125550142', countryCode: 'US' });
    const ca = normalizeMobile({ number: '4165550142', countryCode: 'CA' });
    expect(us?.callingCode).toBe('1');
    expect(ca?.callingCode).toBe('1');
    // +1 covers 20 territories, so the country is real information that cannot
    // be recovered from the number.
    expect(us?.countryCode).toBe('US');
    expect(ca?.countryCode).toBe('CA');
  });

  it('applies per-country length rules rather than a generic digit count', () => {
    expect(normalizeMobile({ number: '12345', countryCode: 'IN' })).toBeNull();
    expect(normalizeMobile({ number: '98765432109876', countryCode: 'IN' })).toBeNull();
  });

  it('keeps the canonical value equal to callingCode + nationalNumber', () => {
    for (const input of [
      { number: '+919876543210' },
      { number: '3125550142', countryCode: 'US' },
      { number: '81234567', countryCode: 'SG' },
    ]) {
      const result = normalizeMobile(input);
      expect(result, JSON.stringify(input)).not.toBeNull();
      expect(isMobileConsistent(result!)).toBe(true);
    }
  });

  it('masks a number without revealing the middle', () => {
    expect(maskMobile('+919876543210')).toBe('+9198***3210');
  });
});

describe('slug and text normalization', () => {
  it('produces a URL-safe slug', () => {
    expect(normalizeSlug('  Acme  Coffee & Co!! ')).toBe('acme-coffee-co');
  });

  it('collapses whitespace but PRESERVES case in free text', () => {
    expect(normalizeText('  Bob   Smith ')).toBe('Bob Smith');
  });
});
