import { z } from 'zod';
import { EmployeeKind, EmployeeStatus } from '@/shared/enums';
import { EmailSchema, MobileInputSchema } from '../auth/credential.contract';

/**
 * Creating a colleague.
 *
 * NOTE WHAT IS ABSENT: a password. The owner supplies a name and a way to reach
 * the person, and nothing else. The person sets their own password from the code
 * that reaches them, so the owner never knows it — which is the only version of
 * this where "who could have sent that message" has one answer.
 */
/** Matches the owner's own name field on signup, so the two cannot diverge. */
const NameSchema = z.string().trim().min(1).max(100);

export const CreateEmployeeRequestSchema = z
  .object({
    firstName: NameSchema,
    lastName: NameSchema.optional(),
    email: EmailSchema.optional(),
    mobile: MobileInputSchema.optional(),
    /** Which role they get. Exactly one; a second can be granted afterwards. */
    roleRefId: z.uuid(),
  })
  .strict()
  .refine((value) => Boolean(value.email) || Boolean(value.mobile), {
    message: 'give at least one of email or mobile',
    path: ['email'],
  });

/** Only the moves a person makes. `invited` is where a creation starts. */
export const EmployeeStatusRequestSchema = z
  .object({
    status: z.enum([EmployeeStatus.Active, EmployeeStatus.Suspended]),
    reason: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine((value) => value.status !== EmployeeStatus.Suspended || Boolean(value.reason), {
    message: 'a reason is required when suspending somebody',
    path: ['reason'],
  });

export const EmployeeQuerySchema = z
  .object({
    /**
     * Whether to include the Wouchh people assigned to this business. Off by
     * default: "who works here" is normally a question about the business's own
     * staff.
     */
    includeSupport: z.enum(['true', 'false']).optional(),
  })
  .strict();

export const EmployeeRolesRequestSchema = z
  .object({ roleRefIds: z.array(z.uuid()).min(1).max(10) })
  .strict();

/** What the client gets back. Contact details are masked, as everywhere else. */
export const EmployeeSchema = z.object({
  refId: z.uuid(),
  name: z.string(),
  email: z.string().nullable(),
  mobile: z.string().nullable(),
  emailVerified: z.boolean(),
  mobileVerified: z.boolean(),
  employeeKind: z.enum(EmployeeKind),
  status: z.enum(EmployeeStatus),
  roles: z.array(z.string()),
  invitedAt: z.date().nullable(),
  joinedAt: z.date().nullable(),
  lastActiveAt: z.date().nullable(),
  lastLoginAt: z.date().nullable(),
});

export type CreateEmployeeRequest = z.infer<typeof CreateEmployeeRequestSchema>;
export type EmployeeStatusRequest = z.infer<typeof EmployeeStatusRequestSchema>;
export type EmployeeRolesRequest = z.infer<typeof EmployeeRolesRequestSchema>;
export type EmployeeQuery = z.infer<typeof EmployeeQuerySchema>;
export type EmployeeDto = z.infer<typeof EmployeeSchema>;
