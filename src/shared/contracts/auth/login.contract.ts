import { z } from 'zod';
import { DeliveryChannel, EmployeeKind, VerificationKind } from '@/shared/enums';
import {
  EmailSchema,
  LoginPasswordSchema,
  MobileInputSchema,
  PasswordSchema,
} from './credential.contract';

/**
 * Login accepts EITHER credential. Which one was sent decides the lookup path,
 * and both resolve to exactly one index probe (schema.md §2).
 */
export const LoginRequestSchema = z
  .object({
    email: EmailSchema.optional(),
    mobile: MobileInputSchema.optional(),
    password: LoginPasswordSchema,
  })
  .strict()
  .refine((value) => Boolean(value.email) !== Boolean(value.mobile), {
    message: 'send exactly one of email or mobile',
  });

export const EmploymentSchema = z.object({
  enterpriseRefId: z.uuid(),
  name: z.string(),
  slug: z.string(),
  employeeKind: z.enum(EmployeeKind),
});

/**
 * Login has three outcomes, and they are separate shapes rather than one shape
 * with everything optional, so a client cannot misread which it got.
 */
export const LoginResponseSchema = z.discriminatedUnion('outcome', [
  // Signed in. The refresh token is set as an httpOnly cookie, never in the body.
  z.object({
    outcome: z.literal('authenticated'),
    accessToken: z.string(),
    expiresInSeconds: z.number().int().positive(),
    // null for a staff actor who has not selected a business yet — the only
    // case where a session legitimately has no enterprise scope.
    enterprise: EmploymentSchema.nullable(),
  }),
  // More than one business: the client picks, then exchanges the selection token.
  z.object({
    outcome: z.literal('enterprise_selection_required'),
    selectionToken: z.string(),
    enterprises: z.array(EmploymentSchema),
  }),
  // Verification needed. NOT an error — a 200 with what the client needs next,
  // and deliberately never the code itself (schema.md §12).
  z.object({
    outcome: z.literal('verification_required'),
    verificationRefId: z.uuid(),
    deliveryChannel: z.enum(DeliveryChannel),
    maskedDestination: z.string(),
    expiresInSeconds: z.number().int().positive(),
  }),
]);

export const VerifyRequestSchema = z
  .object({
    verificationRefId: z.uuid(),
    code: z.string().trim().min(4).max(128),
  })
  .strict();

/**
 * Accepting an invitation: prove the address and choose a password, together.
 *
 * Keyed on the address rather than a verification reference, because the invited
 * person never saw one — whoever invited them made that request, on another
 * device. What they have is their own address and the code that arrived at it.
 *
 * The strength policy applies here, unlike login: this is a password being
 * CHOSEN.
 */
export const AcceptInviteRequestSchema = z
  .object({
    email: EmailSchema.optional(),
    mobile: MobileInputSchema.optional(),
    code: z.string().trim().min(4).max(128),
    password: PasswordSchema,
  })
  .strict()
  .refine((value) => Boolean(value.email) !== Boolean(value.mobile), {
    message: 'send exactly one of email or mobile',
  });

/**
 * Ask for a fresh code for an address that already had one.
 *
 * The KIND is named by the client because one address can legitimately have a
 * challenge of more than one kind — a first login and an invitation — and
 * guessing would resend the wrong one.
 */
export const ResendRequestSchema = z
  .object({
    email: EmailSchema.optional(),
    mobile: MobileInputSchema.optional(),
    purpose: z.enum([VerificationKind.EmployeeInvite, VerificationKind.FirstLogin]),
  })
  .strict()
  .refine((value) => Boolean(value.email) !== Boolean(value.mobile), {
    message: 'send exactly one of email or mobile',
  });

export const SelectEnterpriseRequestSchema = z
  .object({
    selectionToken: z.string().min(16),
    enterpriseRefId: z.uuid(),
  })
  .strict();

export const SwitchEnterpriseRequestSchema = z.object({ enterpriseRefId: z.uuid() }).strict();

/** Refresh may name an enterprise; a malformed value must be a 422, not a 500. */
export const RefreshQuerySchema = z.object({ enterpriseRefId: z.uuid().optional() }).strict();

/**
 * "Sign out everywhere". There is no request schema on purpose: the identity
 * comes from the caller's own access token, so a client sends nothing — and
 * therefore has nothing to send that could name another person's account.
 *
 * The count is the caller's own and is worth returning: "signed out of 4 places"
 * is how somebody confirms the thing they were worried about actually happened.
 */
export const SignOutEverywhereResponseSchema = z.object({
  sessionsRevoked: z.number().int().nonnegative(),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>;
export type ResendRequest = z.infer<typeof ResendRequestSchema>;
export type SelectEnterpriseRequest = z.infer<typeof SelectEnterpriseRequestSchema>;
export type SwitchEnterpriseRequest = z.infer<typeof SwitchEnterpriseRequestSchema>;
export type SignOutEverywhereResponse = z.infer<typeof SignOutEverywhereResponseSchema>;
export type Employment = z.infer<typeof EmploymentSchema>;
