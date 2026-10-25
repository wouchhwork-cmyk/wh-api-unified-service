import { describe, expect, it } from 'vitest';
import {
  SUGGESTED_LINK_LABELS,
  UpdateBusinessSettingsSchema,
} from '@/shared/contracts/enterprises/settings.contract';

/**
 * What a business publishes about itself: a description, its links, and how to
 * reach a person.
 *
 * Every field here is RENDERED TO A CUSTOMER, which is what makes the
 * validation more than hygiene. A label that is secretly a URL shows the
 * customer a second unclickable copy of the address; a `javascript:` link is
 * script execution in their session; a phone number without a country code
 * cannot be dialled by the stranger reading it.
 */
const base = { timezone: 'Asia/Kolkata', currencyCode: 'INR' };
const parse = (body: Record<string, unknown>) =>
  UpdateBusinessSettingsSchema.safeParse({ ...base, ...body });

describe('what a business says about itself', () => {
  it('accepts several paragraphs, up to 5,000 characters', () => {
    const pitch =
      'Hey, we are McDonalds — a chain of fast food restaurants. ' +
      'Our aloo tikki burger and strawberry ice cream are house favourites.';
    expect(parse({ about: pitch }).data?.about).toBe(pitch);

    expect(parse({ about: 'x'.repeat(5000) }).success).toBe(true);
    expect(parse({ about: 'x'.repeat(5001) }).success).toBe(false);
  });

  it('treats a blank description as none, not as an empty one', () => {
    expect(parse({ about: '   ' }).data?.about).toBeNull();
    expect(parse({ about: '  Hello  ' }).data?.about).toBe('Hello');
  });

  /* Absent still means "not talking about it" — the compatibility rule. */
  it('leaves it alone when the body never mentions it', () => {
    expect(parse({}).data).not.toHaveProperty('about');
  });
});

describe('the links a business publishes', () => {
  const link = (label: string, url: string) => parse({ links: [{ label, url }] });

  it('accepts a normal link', () => {
    const result = link('Order online', 'https://mcdonalds.in/order');
    expect(result.success).toBe(true);
    expect(result.data?.links?.[0]).toEqual({
      label: 'Order online',
      url: 'https://mcdonalds.in/order',
    });
  });

  it('offers default names without being limited to them', () => {
    for (const label of SUGGESTED_LINK_LABELS) {
      expect(link(label, 'https://example.com').success).toBe(true);
    }
    /* The point of the list: it is a suggestion, not an enum. */
    expect(link('Book a dog groomer', 'https://example.com').success).toBe(true);
  });

  describe('the name must be a name, not an address', () => {
    it('refuses a label that is a URL', () => {
      expect(link('https://mcdonalds.in', 'https://mcdonalds.in').success).toBe(false);
    });

    it('refuses a label that is a bare domain', () => {
      expect(link('mcdonalds.in', 'https://mcdonalds.in').success).toBe(false);
      expect(link('www.mcdonalds.in', 'https://mcdonalds.in').success).toBe(false);
    });

    it('still allows names that merely contain punctuation or script', () => {
      for (const label of ['Order now 🍟', "Joe's Diner", 'Dine-in', 'मेन्यू', 'ACME — orders']) {
        expect(link(label, 'https://example.com').success).toBe(true);
      }
    });

    it('refuses a name with nothing readable in it', () => {
      expect(link('...', 'https://example.com').success).toBe(false);
      expect(link('   ', 'https://example.com').success).toBe(false);
    });

    it('collapses inner whitespace so one name cannot be typed two ways', () => {
      expect(link('App   Store', 'https://example.com').data?.links?.[0]?.label).toBe('App Store');
    });
  });

  describe('the address must be openable, and only over the web', () => {
    /**
     * THE SECURITY CASE. These are rendered as anchors in a customer's
     * browser: `javascript:` runs in their session, `data:` serves an
     * arbitrary document from our origin, `file:` points at their own disk.
     * None is a business link, and a settings form must not be a way to
     * publish one.
     */
    it('refuses schemes that are not http or https', () => {
      for (const url of [
        'javascript:alert(document.cookie)',
        'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
        'file:///etc/passwd',
        'ftp://example.com/menu.pdf',
      ]) {
        expect(link('Menu', url).success).toBe(false);
      }
    });

    it('refuses something that is not a URL at all', () => {
      for (const url of ['mcdonalds', 'not a url', 'https://', '']) {
        expect(link('Menu', url).success).toBe(false);
      }
    });

    /** Publishing `https://user:pass@host` hands every customer a password. */
    it('refuses a link carrying credentials', () => {
      expect(link('Portal', 'https://admin:hunter2@example.com/orders').success).toBe(false);
    });

    it('accepts plain http as well as https', () => {
      expect(link('Website', 'http://example.com').success).toBe(true);
      expect(link('Website', 'https://example.com/a/b?c=d#e').success).toBe(true);
    });
  });

  it('refuses two links sharing a name, however it is typed', () => {
    const duplicate = parse({
      links: [
        { label: 'Website', url: 'https://a.example.com' },
        { label: '  website  ', url: 'https://b.example.com' },
      ],
    });
    expect(duplicate.success).toBe(false);

    const distinct = parse({
      links: [
        { label: 'Website', url: 'https://a.example.com' },
        { label: 'Order online', url: 'https://b.example.com' },
      ],
    });
    expect(distinct.success).toBe(true);
  });

  it('bounds the list, and accepts an empty one as "I removed them all"', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ label: `Link ${i}`, url: 'https://example.com' }));
    expect(parse({ links: [] }).success).toBe(true);
    expect(parse({ links: rows(20) }).success).toBe(true);
    expect(parse({ links: rows(21) }).success).toBe(false);
  });
});

describe('how a customer reaches the business', () => {
  const contact = (row: Record<string, unknown>) => parse({ contacts: [row] });

  it('accepts a number with its country code, and normalises the punctuation', () => {
    expect(contact({ phone: '+91 98765-43210' }).data?.contacts?.[0]?.phone).toBe('+919876543210');
    expect(contact({ phone: '+1 (415) 555 0123' }).data?.contacts?.[0]?.phone).toBe('+14155550123');
  });

  /**
   * A published number is read by a stranger who cannot supply the country,
   * so it has to carry its own — unlike a login identity, where the person
   * typing it is the one it belongs to.
   */
  it('refuses a number with no country code', () => {
    for (const phone of ['9876543210', '098765 43210', '+', '+0123456789']) {
      expect(contact({ phone }).success).toBe(false);
    }
  });

  it('accepts an email and lower-cases it', () => {
    expect(contact({ email: '  Orders@McDonalds.IN ' }).data?.contacts?.[0]?.email).toBe(
      'orders@mcdonalds.in',
    );
    expect(contact({ email: 'not-an-address' }).success).toBe(false);
  });

  it('lets a region be named, so a chain can list several', () => {
    const result = parse({
      contacts: [
        { label: 'India', phone: '+919876543210', email: 'india@example.com' },
        { label: 'Support', email: 'help@example.com' },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data?.contacts).toHaveLength(2);
  });

  /** A row with neither is a blank line in a contact list. */
  it('refuses an entry that says nothing', () => {
    expect(contact({}).success).toBe(false);
    expect(contact({ label: 'India' }).success).toBe(false);
    expect(contact({ phone: null, email: null }).success).toBe(false);
  });

  it('does not require uniqueness — one address can serve two regions', () => {
    const result = parse({
      contacts: [
        { label: 'Orders', email: 'hello@example.com' },
        { label: 'Support', email: 'hello@example.com' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('bounds the list', () => {
    const rows = (n: number) => Array.from({ length: n }, () => ({ email: 'a@example.com' }));
    expect(parse({ contacts: rows(20) }).success).toBe(true);
    expect(parse({ contacts: rows(21) }).success).toBe(false);
  });
});
