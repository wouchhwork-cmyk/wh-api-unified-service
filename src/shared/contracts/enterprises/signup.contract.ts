import { z } from 'zod';
import { EmailSchema, MobileInputSchema, PasswordSchema } from '../auth/credential.contract';

/**
 * Signup creates the business AND its first employee in one transaction. At least
 * one credential is required — the identities CHECK constraint enforces the same
 * invariant at the database level, so the two can never disagree.
 */
export const SignupRequestSchema = z
  .object({
    business: z
      .object({
        name: z.string().trim().min(2).max(255),
        /** Optional: derived from the name when absent. */
        slug: z
          .string()
          .trim()
          .min(2)
          .max(100)
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lower-case letters, digits and single hyphens only')
          .optional(),
        email: EmailSchema,
        mobile: MobileInputSchema.optional(),
        websiteUrl: z.url().max(2048).optional(),
        country: z
          .string()
          .trim()
          .length(2)
          .regex(/^[A-Za-z]{2}$/)
          .default('IN'),
        timezone: z.string().trim().min(3).max(50).default('Asia/Kolkata'),
        city: z.string().trim().max(100).optional(),
        state: z.string().trim().max(100).optional(),
      })
      .strict(),
    owner: z
      .object({
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().max(100).optional(),
        email: EmailSchema.optional(),
        mobile: MobileInputSchema.optional(),
        password: PasswordSchema,
      })
      .strict()
      .refine((value) => Boolean(value.email) || Boolean(value.mobile), {
        message: 'the owner needs an email address, a mobile number, or both',
      }),
  })
  .strict();

export const SignupResponseSchema = z.object({
  enterpriseRefId: z.uuid(),
  slug: z.string(),
  identityRefId: z.uuid(),
  employeeRefId: z.uuid(),
  /** Signup always requires verification before a session is issued. */
  verificationRefId: z.uuid(),
  maskedDestination: z.string(),
});

export type SignupRequest = z.infer<typeof SignupRequestSchema>;
export type SignupResponse = z.infer<typeof SignupResponseSchema>;
