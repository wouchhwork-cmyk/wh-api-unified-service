import { parsePhoneNumberWithError, type CountryCode, type PhoneNumber } from 'libphonenumber-js';
import { INVISIBLE_PATTERN } from './patterns';

/**
 * A phone number stored as FOUR values, not one (schema.md "Phone numbers are
 * stored decomposed"):
 *
 *   canonical        +919876543210   the single value every uniqueness check uses
 *   countryCode      IN              not recoverable from the number — +1 covers 20 territories
 *   callingCode      91              so splitting the number needs NO parsing
 *   nationalNumber   9876543210      independently indexable, because agents search
 *                                    the way locals write
 */
export interface NormalizedMobile {
  readonly canonical: string;
  readonly countryCode: string;
  readonly callingCode: string;
  readonly nationalNumber: string;
}

export interface MobileInput {
  /** Either a full E.164 string, or a national number plus an explicit country. */
  readonly number: string;
  /** ISO 3166-1 alpha-2. Required unless `number` is already in E.164 form. */
  readonly countryCode?: string | undefined;
}

/**
 * A mobile number is MEANINGLESS WITHOUT A COUNTRY. `9876543210` is not a phone
 * number, it is ten digits. So the API takes either full E.164 or a national
 * number plus an explicit country — never a bare national number with an assumed
 * default, because the assumption silently creates duplicate accounts for the
 * same human in different countries.
 *
 * Returns null rather than throwing: the caller decides which error code applies.
 */
export function normalizeMobile(input: MobileInput): NormalizedMobile | null {
  const raw = input.number.replace(INVISIBLE_PATTERN, '').trim();
  if (!raw) return null;

  const looksE164 = raw.startsWith('+');
  if (!looksE164 && !input.countryCode) return null;

  let parsed: PhoneNumber;
  try {
    parsed = looksE164
      ? parsePhoneNumberWithError(raw)
      : parsePhoneNumberWithError(raw, input.countryCode?.toUpperCase() as CountryCode);
  } catch {
    return null;
  }

  // isValid() applies per-country length and prefix rules — the reason the
  // country and the national part have to be known separately.
  if (!parsed.isValid()) return null;

  const country = parsed.country;
  if (!country) return null;

  return {
    canonical: parsed.number,
    countryCode: country,
    callingCode: parsed.countryCallingCode,
    nationalNumber: parsed.nationalNumber,
  };
}

/**
 * The reconciliation invariant: the canonical value must always equal
 * '+' + callingCode + nationalNumber. One function writes all four columns
 * together; this is what a monitoring query would assert.
 */
export function isMobileConsistent(mobile: NormalizedMobile): boolean {
  return mobile.canonical === `+${mobile.callingCode}${mobile.nationalNumber}`;
}

/** Masks a number for a client response or a log line: `+9198***3210`. */
export function maskMobile(canonical: string): string {
  if (canonical.length < 7) return '***';
  return `${canonical.slice(0, 5)}***${canonical.slice(-4)}`;
}
