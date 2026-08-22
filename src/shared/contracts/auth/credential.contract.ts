import { z } from 'zod';

/**
 * A mobile number is MEANINGLESS WITHOUT A COUNTRY (schema.md). The API takes
 * either a full E.164 string, or a national number plus an explicit country —
 * never a bare national number with an assumed default, because the assumption
 * silently creates duplicate accounts for the same human in different countries.
 */
export const MobileInputSchema = z
  .object({
    number: z.string().trim().min(4).max(24),
    countryCode: z
      .string()
      .trim()
      .length(2)
      .regex(/^[A-Za-z]{2}$/, 'expected an ISO 3166-1 alpha-2 country code')
      .optional(),
  })
  .strict()
  .refine((value) => value.number.startsWith('+') || value.countryCode !== undefined, {
    message: 'countryCode is required unless number is in E.164 form (+…)',
    path: ['countryCode'],
  });

export const EmailSchema = z.string().trim().min(3).max(254);

/**
 * The strength policy, applied where a password is CHOSEN: signup, reset, change.
 *
 * Passwords are not trimmed: a trailing space is part of what the user chose.
 */
export const PasswordSchema = z
  .string()
  .min(10, 'a password must be at least 10 characters')
  .max(200);

/**
 * What LOGIN accepts, which is deliberately weaker: presence only.
 *
 * Enforcing the strength policy at login is a mistake twice over. It tells an
 * attacker the policy for free, and it locks out every account whose password
 * predates the current policy — including internal accounts provisioned from
 * configuration — with a 422 that looks nothing like "wrong password". Whether a
 * password is correct is a question for the hash, not the schema.
 */
export const LoginPasswordSchema = z.string().min(1, 'a password is required').max(200);

export type MobileInputDto = z.infer<typeof MobileInputSchema>;
