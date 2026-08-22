import { z } from 'zod';
import { DeliveryChannel, MemberKind } from '@/shared/enums';
import { EmailSchema, MobileInputSchema, PasswordSchema } from './credential.contract';

/**
 * Login accepts EITHER credential. Which one was sent decides the lookup path,
 * and both resolve to exactly one index probe (schema.md §2).
 */
export const LoginRequestSchema = z
  .object({
    email: EmailSchema.optional(),
    mobile: MobileInputSchema.optional(),
    password: PasswordSchema,
  })
  .strict()
  .refine((value) => Boolean(value.email) !== Boolean(value.mobile), {
    message: 'send exactly one of email or mobile',
  });

export const MembershipSchema = z.object({
  enterpriseRefId: z.uuid(),
  name: z.string(),
  slug: z.string(),
  memberKind: z.enum(MemberKind),
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
    enterprise: MembershipSchema.nullable(),
  }),
  // More than one business: the client picks, then exchanges the selection token.
  z.object({
    outcome: z.literal('enterprise_selection_required'),
    selectionToken: z.string(),
    enterprises: z.array(MembershipSchema),
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

export const SelectEnterpriseRequestSchema = z
  .object({
    selectionToken: z.string().min(16),
    enterpriseRefId: z.uuid(),
  })
  .strict();

export const SwitchEnterpriseRequestSchema = z
  .object({ enterpriseRefId: z.uuid() })
  .strict();

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
export type SelectEnterpriseRequest = z.infer<typeof SelectEnterpriseRequestSchema>;
export type SwitchEnterpriseRequest = z.infer<typeof SwitchEnterpriseRequestSchema>;
export type Membership = z.infer<typeof MembershipSchema>;
