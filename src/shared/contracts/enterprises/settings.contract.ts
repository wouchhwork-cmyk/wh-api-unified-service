import { z } from 'zod';

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
});

export type UpdateBusinessSettingsInput = z.infer<typeof UpdateBusinessSettingsSchema>;
