import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_CURRENCIES,
  SUPPORTED_TIMEZONES,
  UpdateBusinessSettingsSchema,
} from '@/shared/contracts/enterprises/settings.contract';

/**
 * What a business may say its timezone and currency are.
 *
 * BOTH USED TO BE SHAPES RATHER THAN SETS. The timezone was "anything
 * `Intl.DateTimeFormat` does not throw on" and the currency was
 * `/^[A-Z]{3}$/` — so `EST`, `IST` and `XYZ` were all accepted and stored.
 * These tests pin the specific values that used to slip through, because a
 * validator is only as good as the inputs somebody thought to try.
 */
describe('business settings', () => {
  const parse = (timezone: string, currencyCode: string | null = 'INR') =>
    UpdateBusinessSettingsSchema.safeParse({ timezone, currencyCode });

  describe('the timezone', () => {
    it('accepts a full IANA zone name', () => {
      expect(parse('Asia/Kolkata').success).toBe(true);
      expect(parse('America/New_York').success).toBe(true);
      expect(parse('Europe/London').success).toBe(true);
    });

    /**
     * THE ONES THAT USED TO PASS, and the reason this is a set and not a
     * try/catch. `Intl` resolves both, to answers nobody would expect:
     *
     *   EST -> America/Panama        not what an American business means
     *   IST -> Asia/Calcutta         or Irish, or Israel; nobody can tell
     */
    it('refuses an abbreviation, however happily Intl resolves it', () => {
      for (const abbr of ['EST', 'IST', 'PST', 'GMT', 'CET']) {
        expect(parse(abbr).success, `${abbr} must be refused`).toBe(false);
      }
    });

    it('refuses a zone that does not exist', () => {
      expect(parse('Mars/Olympus').success).toBe(false);
      expect(parse('Not/AZone').success).toBe(false);
    });

    /** Both spell the same zone; the column should hold one of them. */
    it('stores the canonical spelling', () => {
      const parsed = parse('Asia/Kolkata');
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        const canonical = new Intl.DateTimeFormat('en', {
          timeZone: 'Asia/Kolkata',
        }).resolvedOptions().timeZone;
        expect(parsed.data.timezone).toBe(canonical);
      }
    });

    it('offers a list the validator agrees with', () => {
      expect(SUPPORTED_TIMEZONES.length).toBeGreaterThan(100);
      /* Spot-check across the list rather than all 400: every entry the
       * dropdown can offer must be one the validator takes. */
      for (const zone of [SUPPORTED_TIMEZONES[0], SUPPORTED_TIMEZONES.at(-1)]) {
        expect(parse(zone as string).success, `${zone} is offered but refused`).toBe(true);
      }
    });
  });

  describe('the currency', () => {
    it('accepts a real ISO 4217 code, in any case', () => {
      expect(parse('Asia/Kolkata', 'INR').success).toBe(true);
      expect(parse('Asia/Kolkata', 'USD').success).toBe(true);
      const lower = parse('Asia/Kolkata', 'usd');
      expect(lower.success).toBe(true);
      if (lower.success) expect(lower.data.currencyCode).toBe('USD');
    });

    /** The exact inputs the old three-letter regex waved through. */
    it('refuses a three-letter code that is not a currency', () => {
      for (const code of ['XYZ', 'ABC', 'ZZZ', 'QQQ']) {
        expect(parse('Asia/Kolkata', code).success, `${code} must be refused`).toBe(false);
      }
    });

    /**
     * NULL IS A REAL ANSWER: this business has not chosen one. It is what
     * makes "set a currency before you can grant money" possible to say,
     * instead of silently paying in a default nobody picked.
     */
    it('accepts null, which means not chosen', () => {
      expect(parse('Asia/Kolkata', null).success).toBe(true);
    });

    it('offers a list the validator agrees with', () => {
      expect(SUPPORTED_CURRENCIES.length).toBeGreaterThan(100);
      for (const code of [SUPPORTED_CURRENCIES[0], SUPPORTED_CURRENCIES.at(-1)]) {
        expect(parse('Asia/Kolkata', code as string).success, `${code} offered but refused`).toBe(
          true,
        );
      }
    });
  });

  /** Identity is not preference: this screen does not rename a business. */
  it('refuses fields that are not settings', () => {
    const parsed = UpdateBusinessSettingsSchema.safeParse({
      timezone: 'Asia/Kolkata',
      currencyCode: 'INR',
      name: 'Renamed Co',
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The customer-facing business name.
 *
 * Its whole job is to be shown to somebody who is not in the business, so the
 * interesting cases are the ones about what reaches a customer and what a save
 * does to a name nobody mentioned.
 */
describe('the customer-facing name', () => {
  const parse = (body: Record<string, unknown>) =>
    UpdateBusinessSettingsSchema.safeParse({
      timezone: 'Asia/Kolkata',
      currencyCode: 'INR',
      ...body,
    });

  /**
   * THE COMPATIBILITY CASE, and the reason the field is optional.
   *
   * This body is exactly what a client written before the field existed
   * sends. It must still be accepted, and — the part that matters — it must
   * NOT carry an instruction about the name, or every such save would wipe a
   * name the business had chosen.
   */
  it('accepts a body that never mentions it, and says nothing about the name', () => {
    const result = parse({});
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('displayName');
    expect(result.data?.displayName).toBeUndefined();
  });

  /** Absent and null are different requests: leave it alone vs clear it. */
  it('distinguishes "not mentioned" from an explicit null', () => {
    expect(parse({}).data?.displayName).toBeUndefined();

    const cleared = parse({ displayName: null });
    expect(cleared.success).toBe(true);
    expect(cleared.data?.displayName).toBeNull();
  });

  it('keeps marketing copy intact — emoji, punctuation, mixed script', () => {
    for (const name of ['Acme ☕', "Joe's Diner!", 'कैफे Acme', 'ACME — since 1998']) {
      expect(parse({ displayName: name }).data?.displayName).toBe(name);
    }
  });

  it('trims, and treats a blank name as no name rather than storing it', () => {
    expect(parse({ displayName: '  Acme  ' }).data?.displayName).toBe('Acme');
    expect(parse({ displayName: '' }).data?.displayName).toBeNull();
    expect(parse({ displayName: '   ' }).data?.displayName).toBeNull();
  });

  /** "No format rules" cannot mean "no limit" — the column is VARCHAR(160). */
  it('refuses a name longer than the column holds', () => {
    expect(parse({ displayName: 'a'.repeat(160) }).success).toBe(true);
    expect(parse({ displayName: 'a'.repeat(161) }).success).toBe(false);
  });

  /** Still a strict object: a typo must not be silently discarded. */
  it('refuses an unknown field', () => {
    expect(parse({ displayname: 'Acme' }).success).toBe(false);
  });
});
