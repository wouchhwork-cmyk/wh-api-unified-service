/**
 * Input normalization (schema.md "Input normalization — stored form is
 * canonical"). Anything used as a lookup or uniqueness key is normalized ONCE,
 * at the service boundary, before it reaches the repository — never at read
 * time, never in two places, never trusted from the client.
 */

/** Zero-width and exotic Unicode spaces that survive a naive trim(). */
const INVISIBLE = /[​-‍﻿⁠­]/g;
const UNICODE_SPACES = /[   -   　]/g;

/**
 * Free text: trim, collapse internal whitespace runs, NFC. Case PRESERVED —
 * `Bob  Smith` becomes `Bob Smith`, not `bob smith`.
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(UNICODE_SPACES, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Free text that may be absent; empty becomes null so NOT NULL means something. */
export function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : null;
}

/**
 * Slug: trim, lower-case, non-alphanumerics to `-`, collapse repeats, strip
 * leading and trailing `-`.
 */
/**
 * enterprises.slug is VARCHAR(100), and a business name may be up to 255
 * characters, so the result is bounded here — the one place slugs are made.
 * Truncating leaves room for the `-2` disambiguation suffix a collision adds.
 */
const MAX_SLUG_LENGTH = 90;

export function normalizeSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(INVISIBLE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Trim at the boundary, then strip a hyphen the cut may have left dangling.
  return slug.length <= MAX_SLUG_LENGTH ? slug : slug.slice(0, MAX_SLUG_LENGTH).replace(/-$/, '');
}

/** URL: lower-case scheme and host, strip a default port, KEEP path case. */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // URL already lower-cases protocol and hostname and drops default ports.
  return url.toString();
}
