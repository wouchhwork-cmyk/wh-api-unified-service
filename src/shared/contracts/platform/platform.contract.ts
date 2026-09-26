import { z } from 'zod';
import { EnterpriseFeatureStatus, EnterpriseStatus, FeatureKey, StaffStatus } from '@/shared/enums';
import { MAX_PAGE_SIZE } from '@/shared/constants';
import { EmailSchema, MobileInputSchema } from '../auth/credential.contract';

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

/**
 * The window a rate-limit chart covers.
 *
 * Bounded at both ends. The lower bound is one bucket — anything shorter would
 * return a single point and read as a flat line — and the upper bound matches
 * the retention window, because asking for more returns less than was asked for
 * and looks like data loss rather than a setting.
 */
export const PlatformRateLimitHistoryQuerySchema = z
  .object({
    windowMinutes: z.coerce.number().int().min(1).max(48 * 60).optional(),
    /** One pool, by its scope key, when drilling into a single line. */
    scopeKey: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().positive().max(5000).optional(),
  })
  .strict();

export type PlatformRateLimitHistoryQuery = z.infer<typeof PlatformRateLimitHistoryQuerySchema>;

/**
 * The staff roles somebody should hold afterwards.
 *
 * May be EMPTY, unlike the tenant-side equivalent. An employee with no roles is
 * indistinguishable from a half-finished invitation, so that one insists on at
 * least one; a staff member with no roles is a meaningful state — somebody who
 * still works here and currently reaches nothing.
 */
export const PlatformStaffRolesSchema = z
  .object({ roleRefIds: z.array(z.uuid()).max(10) })
  .strict();

export type PlatformStaffRolesRequest = z.infer<typeof PlatformStaffRolesSchema>;

/** Matches the tenant-side employee name fields, so the two cannot diverge. */
const StaffNameSchema = z.string().trim().min(1).max(100);

/**
 * Adding one of our own people.
 *
 * NOTE WHAT IS ABSENT, in both directions.
 *
 * No password — the same reasoning as a tenant invite: the person sets their
 * own from the code that reaches them, so the admin creating the account never
 * knows it.
 *
 * And no `hasAllEnterpriseAccess`. A full platform admin is the highest
 * authority in the product, answerable to nobody and scoped to nothing, and
 * promoting somebody to one is not a checkbox on a create form. That stays
 * where it is — `PLATFORM_ADMIN_*` in the deployment configuration, which
 * takes a deploy and leaves a trail in a repository. Everybody created here is
 * scoped staff whose reach is exactly the roles they are given.
 */
export const PlatformStaffInviteSchema = z
  .object({
    firstName: StaffNameSchema,
    lastName: StaffNameSchema.optional(),
    email: EmailSchema.optional(),
    mobile: MobileInputSchema.optional(),
    /**
     * Optional, and may be empty: somebody who works here and reaches nothing
     * yet is a real state, and roles can be granted the moment they accept.
     */
    roleRefIds: z.array(z.uuid()).max(10).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.email) || Boolean(value.mobile), {
    message: 'give at least one of email or mobile',
    path: ['email'],
  });

/**
 * The moves an administrator can make on a staff member.
 *
 * `invited` is absent because it is where a creation starts and nothing returns
 * to it. `active` is present but heavily guarded in the service: it reinstates
 * somebody who genuinely worked here and cannot manufacture an acceptance.
 */
export const PlatformStaffStatusSchema = z
  .object({
    status: z.enum([StaffStatus.Active, StaffStatus.Suspended]),
    reason: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine((value) => value.status !== StaffStatus.Suspended || Boolean(value.reason), {
    message: 'a reason is required when suspending somebody',
    path: ['reason'],
  });

export type PlatformStaffInviteRequest = z.infer<typeof PlatformStaffInviteSchema>;
export type PlatformStaffStatusRequest = z.infer<typeof PlatformStaffStatusSchema>;
