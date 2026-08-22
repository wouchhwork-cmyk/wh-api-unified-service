import { VerificationKind, VerificationSecretShape } from '@/shared/enums';
import type { VerificationKindConfig } from './config.types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Per-kind verification parameters (schema.md §12).
 *
 * The distinction that matters: a SHORT window plus an attempt limit for a code
 * sent to a device the person is holding, versus HIGH ENTROPY plus a longer
 * window for a link that has to survive an inbox. A 6-digit reset valid for
 * 24 hours would be brute-forceable; a long token valid for 10 minutes would be
 * unusable.
 *
 * Structured config rather than flat env vars, because these are per-kind.
 * Adding a kind is an entry here plus an enum value — never a migration.
 */
const code = (expiryMs: number, maxAttempts = 5): VerificationKindConfig => ({
  secretShape: VerificationSecretShape.NumericCode,
  secretSize: 6,
  expiryMs,
  maxAttempts,
  resendCooldownMs: 60_000,
  hourlyDestinationCap: 5,
});

const token = (expiryMs: number, maxAttempts = 3): VerificationKindConfig => ({
  secretShape: VerificationSecretShape.Token,
  secretSize: 32,
  expiryMs,
  maxAttempts,
  resendCooldownMs: 5 * MINUTE,
  hourlyDestinationCap: 3,
});

export const VERIFICATION_CONFIG: Readonly<Record<VerificationKind, VerificationKindConfig>> = {
  [VerificationKind.FirstLogin]: code(10 * MINUTE),
  [VerificationKind.EmailVerification]: code(24 * HOUR),
  [VerificationKind.MobileVerification]: code(10 * MINUTE),
  [VerificationKind.IdentifierChange]: code(10 * MINUTE),
  /** A link, not a code — a guessable reset is an account takeover. */
  [VerificationKind.PasswordReset]: token(30 * MINUTE),
  /*
   * A CODE, despite being long-lived — which looks like it contradicts the rule
   * above, and does not.
   *
   * A token only works when the person can be handed a LINK containing both the
   * verification reference and the secret, because a token is far too long to
   * type. An invited colleague is on a different device from whoever invited
   * them: they never see the API response the reference came back in. So the
   * invite is looked up by the destination they already know — their own address
   * — plus a code short enough to read off a phone.
   *
   * The entropy argument still holds. Brute force is bounded by 5 attempts on the
   * one live row, and only somebody already inside the business can create
   * another, so a guessing attack gets 5 tries in 1,000,000 and then needs a
   * fresh invitation it cannot request.
   */
  [VerificationKind.EmployeeInvite]: code(7 * DAY),
  [VerificationKind.CustomerMobileVerification]: code(10 * MINUTE),
  [VerificationKind.CustomerEmailVerification]: code(24 * HOUR),
} as const;
