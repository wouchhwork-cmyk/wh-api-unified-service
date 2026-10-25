import { z } from 'zod';
import { EmailSchema } from '@/shared/contracts/auth/credential.contract';

/**
 * Every timezone this service will accept, as the runtime's IANA database
 * lists them. 417 of them at the time of writing.
 *
 * THE LIST IS THE STANDARD, and it is computed rather than hand-written so it
 * cannot drift from what `Intl` will actually resolve later. The same array is
 * served to the portal, which renders it as a dropdown — so the set a person
 * can choose from and the set the server accepts are the same object, and
 * neither can grow a value the other rejects.
 */
export const SUPPORTED_TIMEZONES: readonly string[] = Intl.supportedValuesOf('timeZone');

const SUPPORTED = new Set(SUPPORTED_TIMEZONES);

/**
 * UTC is not in the IANA list — it is an alias — and it is a legitimate answer
 * for a business that does not sit anywhere in particular.
 */
const EXTRA_ALLOWED = new Set(['UTC']);

/**
 * Resolves what the runtime would actually use, or null if it would refuse.
 *
 * Note `Asia/Kolkata` resolves to `Asia/Calcutta` on this ICU, not the other
 * way round. Both name the same zone; the canonical form is what gets stored,
 * so the column holds one spelling rather than two.
 */
function canonical(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * A business's own timezone.
 *
 * THE BUSINESS IS THE AUTHORITY. This is the only place it is set, and every
 * feature that needs to know what "today" or "6pm" means for a business reads
 * `enterprises.timezone` — reward cap periods, happy-hour windows, and
 * whatever comes next. Nothing else keeps a copy.
 *
 * Reward programs used to keep one. Each took a timezone at creation, so a
 * business could end up with two programs disagreeing about when Tuesday
 * starts and nothing reconciling them. A per-feature copy of a business fact
 * is a fact that will eventually be wrong in one place.
 *
 * ABBREVIATIONS ARE REFUSED, and that is the point of validating against the
 * list rather than asking `Intl` whether it throws. `Intl` accepts plenty that
 * must not be stored:
 *
 *   EST  resolves to  America/Panama     — not what an American business means
 *   IST  resolves to  Asia/Calcutta      — or Irish, or Israel; nobody can tell
 *
 * Both would have passed a try/catch check and silently pinned a business to
 * the wrong offset. A name with no region is ambiguous by construction, so the
 * rule is: it must contain a `/`, and its resolved form must be one the
 * runtime lists. `UTC` is the single deliberate exception.
 */
export const TimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((tz, ctx) => {
    if (EXTRA_ALLOWED.has(tz.toUpperCase())) return tz.toUpperCase();

    /* No region, no deal — this is what stops EST and IST. */
    if (!tz.includes('/')) {
      ctx.addIssue({
        code: 'custom',
        message: 'use a full zone name such as Asia/Kolkata, not an abbreviation',
      });
      return z.NEVER;
    }

    const resolved = canonical(tz);
    if (resolved === null || !SUPPORTED.has(resolved)) {
      ctx.addIssue({ code: 'custom', message: 'not a recognised IANA timezone' });
      return z.NEVER;
    }

    /* Stored canonical, so the column holds one spelling of each zone. */
    return resolved;
  });

/**
 * Every currency this service will accept, as ISO 4217 defines them. 162 of
 * them at the time of writing.
 *
 * Computed, and served to the portal, for the same reason as the timezone
 * list: one set, used by the validator and the dropdown alike.
 */
export const SUPPORTED_CURRENCIES: readonly string[] = Intl.supportedValuesOf('currency');

const CURRENCIES = new Set(SUPPORTED_CURRENCIES);

/**
 * An ISO 4217 currency code.
 *
 * CHECKED AGAINST THE LIST, not a shape. This was `/^[A-Z]{3}$/`, which is a
 * description of what a currency code LOOKS like rather than a test of
 * whether it is one — so `XYZ`, `ABC` and `ZZZ` were all accepted and stored,
 * and a wallet could be opened in a currency that does not exist. Nothing
 * downstream would ever reconcile it, because there is nothing to reconcile
 * it against.
 *
 * Upper-cased before the check, so `inr` is accepted and `INR` is stored:
 * case is a typing convenience, not a different currency.
 */
export const CurrencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((code) => CURRENCIES.has(code), 'not an ISO 4217 currency code');

/**
 * A LABEL is a name, and this is what stops it being a link.
 *
 * The business types both halves of a link row, and the whole point of the
 * label is that a customer reads it instead of the URL. A label holding
 * `https://...` or `mcdonalds.com` defeats that — it shows the customer a
 * second, unclickable copy of the address — so the shapes of a URL are
 * refused here rather than rendered.
 *
 * DELIBERATELY NOT A WHITELIST OF ALLOWED CHARACTERS. "Order now 🍟",
 * "Dine-in", "मेन्यू" and "App Store" are all things a business may
 * legitimately want to say, and a regex permissive enough for those is not a
 * meaningful constraint anyway. What is checked is the three ways a label
 * turns out to be an address, plus a floor: at least one letter or digit, so
 * a row cannot be labelled "..." and render as nothing.
 */
const LABEL_LOOKS_LIKE_A_URL = /:\/\//;
const LABEL_IS_BARE_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const LABEL_HAS_SOMETHING_READABLE = /[\p{L}\p{N}]/u;

export const LinkLabelSchema = z
  .string()
  .trim()
  /* Internal runs of whitespace collapse: "App   Store" and "App Store" are
   * the same label, and only one of them should decide a uniqueness check. */
  .transform((value) => value.replace(/\s+/gu, ' '))
  .pipe(
    z
      .string()
      .min(1, 'a link needs a name')
      .max(40)
      .refine((v) => !LABEL_LOOKS_LIKE_A_URL.test(v), {
        message: 'this is the name customers read, not the address — put the link in the url field',
      })
      .refine((v) => !LABEL_IS_BARE_DOMAIN.test(v), {
        message: 'this looks like a web address rather than a name',
      })
      .refine((v) => LABEL_HAS_SOMETHING_READABLE.test(v), {
        message: 'a name needs at least one letter or number',
      }),
  );

/**
 * A URL that can actually be opened, and only over the web.
 *
 * PARSED, NOT PATTERN-MATCHED. `new URL` is the same parser the browser will
 * use, so a value accepted here is one a customer's browser agrees about —
 * which a regex cannot promise.
 *
 * THE SCHEME IS AN ALLOWLIST, and that is the security half. These links are
 * published to customers and rendered as anchors: `javascript:` is script
 * execution in the reader's session, `data:` is an arbitrary document served
 * from our own page's context, and `file:` points at the reader's disk. None
 * of them is a business link, and none of them should be reachable by typing
 * one into a settings form.
 *
 * CREDENTIALS ARE REFUSED for a different reason — `https://user:pass@host`
 * is a valid URL, and publishing one hands every customer a password. A
 * business pasting a link from somewhere else should be told, not quietly
 * obeyed.
 */
export const BusinessUrlSchema = z
  .string()
  .trim()
  .min(1, 'a link needs an address')
  .max(2048)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'expected a full web address, starting with https://',
      });
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      ctx.addIssue({
        code: 'custom',
        message: 'only http and https links can be shared with customers',
      });
    }
    if (parsed.username !== '' || parsed.password !== '') {
      ctx.addIssue({ code: 'custom', message: 'remove the username and password from this link' });
    }
    if (parsed.hostname === '') {
      ctx.addIssue({ code: 'custom', message: 'this address names no site' });
    }
  });

/**
 * Names the portal offers for a link, which the business may ignore.
 *
 * SUGGESTIONS, NOT AN ENUM. The set of things a business might usefully point
 * a customer at is not knowable from here — a clinic wants "Book an
 * appointment", a restaurant "Order on Swiggy", a gym its class timetable. So
 * the API serves the common ones to save typing and the schema accepts
 * anything that is a name; see `LinkLabelSchema`.
 *
 * Served rather than hardcoded in the portal for the same reason the timezone
 * list is: one copy, so the two cannot drift.
 */
export const SUGGESTED_LINK_LABELS = [
  'Website',
  'Order online',
  'Menu',
  'Book a table',
  'App Store',
  'Play Store',
  'Directions',
  'WhatsApp',
  'Instagram',
  'Support',
] as const;

export const BusinessLinkSchema = z.strictObject({
  label: LinkLabelSchema,
  url: BusinessUrlSchema,
});

/**
 * A published phone number, which is not the same thing as a login identity.
 *
 * E.164 ONLY — `+` and 8 to 15 digits — rather than reusing
 * `MobileInputSchema`. That schema accepts a national number alongside an
 * explicit country because a person signing up types their own number the way
 * they say it out loud. This number is RENDERED TO A STRANGER, who has no way
 * to supply the missing country, so it has to carry its own.
 *
 * Punctuation is stripped rather than refused: a business pasting
 * "+91 98765-43210" means a number, and failing them over a space teaches
 * nothing. What is stored is the canonical form.
 */
export const PublishedPhoneSchema = z
  .string()
  .trim()
  .max(32)
  .transform((value) => value.replace(/[\s()\u2010-\u2015.-]/gu, ''))
  .pipe(
    z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, 'expected a number with its country code, like +919876543210'),
  );

/**
 * One way to reach the business, and there may be several.
 *
 * AN ARRAY BECAUSE A BUSINESS IS NOT ONE PLACE. A chain has a number per
 * region and often a different address for support than for orders, and
 * flattening that into one field makes the business choose which of its
 * customers to serve badly. `label` is what tells them apart — "India",
 * "Support", "Andheri branch" — and is optional, because a business with one
 * number has nothing to disambiguate.
 *
 * AN ENTRY MUST SAY SOMETHING. A row with neither a number nor an address is
 * a blank line in a contact list; the form can hold one while it is being
 * filled in, but it must not be saved.
 */
export const BusinessContactSchema = z
  .strictObject({
    label: LinkLabelSchema.nullable().optional(),
    phone: PublishedPhoneSchema.nullable().optional(),
    email: EmailSchema.toLowerCase().nullable().optional(),
  })
  .refine((value) => Boolean(value.phone) || Boolean(value.email), {
    message: 'a contact needs a phone number or an email address',
  });

/**
 * What a business may change about itself.
 *
 * STRICT and deliberately small. This is not the signup form: name, slug and
 * email are identity rather than preference, and changing them has
 * consequences a settings screen should not have — a slug is in URLs, an email
 * is unique across live businesses. They are not editable here merely because
 * they sit on the same row.
 */
export const UpdateBusinessSettingsSchema = z.strictObject({
  /**
   * What CUSTOMERS are told the business is called.
   *
   * The business's own `name` is usually its registered entity, because that
   * is what gets typed at signup — and "Acme Foods Pvt Ltd" is a poor way to
   * open a thank-you message. This is the name that goes in front of a
   * customer, and it is editable here precisely because it IS a preference:
   * unlike name, slug and email it addresses nobody and identifies nothing, so
   * changing it breaks no URL and collides with no other business.
   *
   * It is marketing copy — emoji, punctuation, mixed script, whatever the
   * business wants to be called. Bounded at 160 anyway, matching a reward
   * programme's display name, because "no checks" cannot mean "no limit".
   * Trimmed, and an empty string becomes NULL rather than a name that renders
   * as nothing.
   *
   * OPTIONAL, AND THAT IS A COMPATIBILITY DECISION, not an oversight. This is
   * a strict full-restatement PUT: `timezone` and `currencyCode` are required
   * and a caller that omits one is refused. Making this one required would
   * break every client that already saves settings, and giving it
   * `.default(null)` would be worse — a client written before this field
   * existed would silently CLEAR the business's chosen name on every save.
   * Absent therefore means "leave it as it is", and `null` means "clear it".
   * Those are different requests and the service treats them as such.
   */
  displayName: z
    .string()
    .trim()
    .max(160)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional(),
  /*
   * NULLABLE for the same reason the currency is: "not chosen" is a real
   * answer. It used to default to Asia/Kolkata at signup, so a business in
   * London had a timezone it never picked and no way to notice — "once a
   * day" resetting at half past six in the evening, correctly, for entirely
   * the wrong reason.
   */
  timezone: TimezoneSchema.nullable(),
  /**
   * The currency the business works in.
   *
   * Like the timezone, it lived on each reward program and was copied at
   * creation. A benefit may still name a DIFFERENT currency explicitly — a
   * business can run a promotion in another one — but when it does not, this
   * is the answer, and there is one of it.
   */
  /*
   * NULLABLE, because "not chosen" is a real answer and a business may clear
   * it. A rule that would grant money is refused while it is null rather than
   * being handed a default nobody picked.
   */
  currencyCode: CurrencyCodeSchema.nullable(),
  /**
   * What the business says about itself, in its own words.
   *
   * Free text and deliberately so — this is the paragraph a customer reads,
   * and a business describing itself is not a field anybody should shape.
   * 5,000 characters, which is several paragraphs and still a bound: an
   * unbounded string from a request body is a way to put a megabyte in a row.
   *
   * Blank becomes NULL rather than being stored as an empty description, so
   * "they have not written one" stays distinguishable from "they wrote
   * nothing".
   */
  about: z
    .string()
    .trim()
    .max(5000)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional(),
  /**
   * Where the business wants its customers to go.
   *
   * Ordered, because the order is the business's answer to "what matters
   * most" — the list is rendered as given rather than sorted.
   *
   * LABELS ARE UNIQUE, case- and spacing-insensitively. Two rows both called
   * "Website" are indistinguishable to the customer reading them, and the
   * business cannot have meant that; being refused is how they find out they
   * need "Website" and "Order online" rather than two of the same word. It
   * also makes a label usable as a key later without that being a new
   * promise.
   *
   * Capped at 20: a list longer than that is not a set of useful links, and
   * every entry is rendered to a customer.
   */
  links: z
    .array(BusinessLinkSchema)
    .max(20)
    .refine((rows) => new Set(rows.map((row) => row.label.toLowerCase())).size === rows.length, {
      message: 'two links cannot share a name',
    })
    .optional(),
  /**
   * How a customer reaches a person.
   *
   * Same bound and the same absent-vs-null rule as the rest of this object.
   * Not uniqueness-checked: two regions legitimately share a support address,
   * and a business listing the same number under "Orders" and "Support" is
   * telling its customers something true.
   */
  contacts: z.array(BusinessContactSchema).max(20).optional(),
});

export type UpdateBusinessSettingsInput = z.infer<typeof UpdateBusinessSettingsSchema>;
