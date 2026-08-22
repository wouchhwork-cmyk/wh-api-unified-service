import { INVISIBLE_PATTERN } from './patterns';

/**
 * Email normalization: trim → strip zero-width and Unicode-space characters →
 * LOWER-CASE THE WHOLE ADDRESS → NFC.
 *
 * The local part is technically case-sensitive per RFC 5321, but no mail
 * provider in practice treats it that way and users expect `Bob@x.com` to reach
 * their account. Lower-casing everything is the deliberate choice, and the
 * unique index is on `lower(email)` to match.
 */
export function normalizeEmail(value: string): string {
  return value.normalize('NFC').replace(INVISIBLE_PATTERN, '').trim().toLowerCase();
}

/**
 * Deliberately conservative: one @, no whitespace, a dot-containing domain, and
 * length limits from RFC 5321. Rejects rather than mangles — an unparseable
 * address is a 422, never a best-effort guess written to the database.
 */
const EMAIL_PATTERN = /^[^\s@,;:<>"()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isValidEmail(normalized: string): boolean {
  if (normalized.length < 3 || normalized.length > 254) return false;
  if (!EMAIL_PATTERN.test(normalized)) return false;
  const [local = '', domain = ''] = normalized.split('@');
  if (local.length > 64 || domain.length > 253) return false;
  // A leading, trailing, or doubled dot in the local part is invalid unquoted.
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return true;
}

/** Masks an address for a client response or a log line: `bo***@example.com`. */
export function maskEmail(normalized: string): string {
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}${domain}`;
}
