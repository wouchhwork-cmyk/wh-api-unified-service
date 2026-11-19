import { IdentifierKind } from '@/shared/enums';
import { isValidEmail, normalizeEmail } from './email.normalize';
import { normalizeMobile } from './mobile.normalize';

/** A contact detail cleaned up and fit to store. */
export interface CleanContact {
  /** What goes in `identifier_value` — the column every lookup reads. */
  readonly canonical: string;
  /** The decomposition, for a phone number. Absent for an email. */
  readonly mobile?: {
    readonly countryCode: string;
    readonly callingCode: string;
    readonly nationalNumber: string;
  };
}

/**
 * Why a contact could not be stored.
 *
 * TWO FAILURES, NOT ONE, because they need two different things done about
 * them. `unreadable` is "that is not a number" and the fix is to look at it
 * again. `needs_country` is "that may well be a number, in which country?"
 * and the fix is to ASK — the one question that actually gets a usable
 * answer, and the one a single null would have thrown away.
 */
export type ContactProblem = 'unreadable' | 'needs_country';

export type CleanContactResult =
  | { readonly ok: true; readonly contact: CleanContact }
  | { readonly ok: false; readonly problem: ContactProblem; readonly choices: readonly string[] };

/**
 * ONE PLACE A CONTACT IS MADE FIT TO STORE, for every way one arrives.
 *
 * A number can reach this service three ways — a customer typing it in a
 * chat, the assistant recording it with `record_customer_details`, or a
 * colleague adding it on the portal — and all three must produce the SAME
 * row, or the uniqueness that `identifier_value` exists to provide is not
 * uniqueness at all. The same person added by hand and recorded by the
 * assistant would simply be two records.
 *
 * THE COUNTRY IS NEVER GUESSED. This is the rule the whole function is
 * built around, and it was learned the expensive way: a number read as
 * belonging to the wrong country is wrong, looks right, and gets dialled.
 * There is no safe default, so there is no default. The country comes from
 * one of exactly three places, in this order:
 *
 *   1. THE NUMBER, when it was written with a leading + — explicit, and
 *      true wherever the business happens to trade
 *   2. A COUNTRY SOMEBODY STATED, passed as `stated`
 *   3. THE BUSINESS'S ONE OPERATIONAL COUNTRY, when it has exactly one
 *
 * The third is not an assumption. A business that has said it operates in
 * India and nowhere else has told us what a bare Indian-looking number is.
 * Where it operates in two or more, that statement does not exist and the
 * answer is to ASK — which is what `needs_country` is for, and why it
 * carries the choices worth offering.
 *
 * RETURNS A PROBLEM RATHER THAN THROWING. The caller decides what a bad
 * contact means — a 422 on the portal, a note back to the model in a tool
 * result, a question put to the customer — but nobody gets to write a
 * best-effort number into the identifier table.
 */
export function cleanContact(input: {
  kind: IdentifierKind;
  value: string;
  /** A country somebody actually stated, ISO 3166-1 alpha-2. */
  stated?: string | null | undefined;
  /** Where this business says it operates. One entry settles the question. */
  operatesIn?: readonly string[] | undefined;
}): CleanContactResult {
  const operatesIn = (input.operatesIn ?? [])
    .map((code) => code.trim().toUpperCase())
    .filter((code) => /^[A-Z]{2}$/.test(code));

  if (input.kind === IdentifierKind.Email) {
    const canonical = normalizeEmail(input.value);
    return isValidEmail(canonical)
      ? { ok: true, contact: { canonical } }
      : { ok: false, problem: 'unreadable', choices: [] };
  }

  const international = input.value.trim().startsWith('+');
  /*
   * Two letters or nothing. A model given a free-text field will eventually
   * write "India", and a form will eventually be given "+91" — feeding
   * either to the parser as a region code is how a valid number silently
   * becomes a null.
   */
  const said = input.stated?.trim().toUpperCase() ?? '';
  const stated = /^[A-Z]{2}$/.test(said) ? said : null;
  /* Exactly one, or nothing. Two is a question, not a default. */
  const declared = operatesIn.length === 1 ? (operatesIn[0] ?? null) : null;
  const country = stated ?? declared;

  if (!international && !country) {
    return { ok: false, problem: 'needs_country', choices: operatesIn };
  }

  const parsed = normalizeMobile({
    number: input.value,
    ...(country ? { countryCode: country } : {}),
  });
  if (!parsed) return { ok: false, problem: 'unreadable', choices: operatesIn };

  return {
    ok: true,
    contact: {
      canonical: parsed.canonical,
      mobile: {
        countryCode: parsed.countryCode,
        callingCode: parsed.callingCode,
        nationalNumber: parsed.nationalNumber,
      },
    },
  };
}
