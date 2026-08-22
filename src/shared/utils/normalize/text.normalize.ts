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
export function normalizeSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(INVISIBLE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
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
