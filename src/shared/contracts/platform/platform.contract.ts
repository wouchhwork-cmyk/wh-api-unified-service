import { z } from 'zod';
import { EnterpriseFeatureStatus, EnterpriseStatus, FeatureKey } from '@/shared/enums';
import { MAX_PAGE_SIZE } from '@/shared/constants';

export const PlatformEnterpriseQuerySchema = z
  .object({
    /** Free text over name, slug and email. Bounded, and bound as a parameter. */
    search: z.string().trim().min(1).max(120).optional(),
    status: z.enum(EnterpriseStatus).optional(),
    limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
    cursor: z.string().max(512).optional(),
  })
  .strict();

/**
 * Only the two statuses an admin can MOVE a business to.
 *
 * `pending_activation` is absent on purpose: it is where a signup starts, and
 * putting a live business back into it would leave it in a state whose meaning
 * ("we have not looked at this yet") would no longer be true.
 */
export const PlatformEnterpriseStatusSchema = z
  .object({
    status: z.enum([EnterpriseStatus.Active, EnterpriseStatus.Suspended]),
    /** Recorded in the audit trail. Required to suspend — never silently. */
    reason: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine((v) => v.status !== EnterpriseStatus.Suspended || Boolean(v.reason), {
    message: 'a reason is required when suspending a business',
    path: ['reason'],
  });

/**
 * What an admin can do to a feature. A subset of the full state machine: only
 * these four are decisions a human makes, and `expired` is the sweeper's to set.
 */
export const PlatformFeatureDecisionSchema = z
  .object({
    status: z.enum([
      EnterpriseFeatureStatus.Active,
      EnterpriseFeatureStatus.Disabled,
      EnterpriseFeatureStatus.Declined,
      EnterpriseFeatureStatus.Revoked,
    ]),
    reason: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.status !== EnterpriseFeatureStatus.Declined &&
        v.status !== EnterpriseFeatureStatus.Revoked) ||
      Boolean(v.reason),
    { message: 'a reason is required to decline or revoke a feature', path: ['reason'] },
  );

export const PlatformFeatureKeyParamSchema = z.enum(FeatureKey);

export type PlatformEnterpriseQuery = z.infer<typeof PlatformEnterpriseQuerySchema>;
export type PlatformEnterpriseStatusRequest = z.infer<typeof PlatformEnterpriseStatusSchema>;
export type PlatformFeatureDecisionRequest = z.infer<typeof PlatformFeatureDecisionSchema>;
