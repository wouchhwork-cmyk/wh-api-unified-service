import { z } from 'zod';
import { MAX_CREATABLE_ROLE_LEVEL, MIN_ROLE_LEVEL } from '@/shared/enums';

/**
 * The name a business gives a role.
 *
 * Trimmed and collapsed before length is judged, so "  Shift   lead  " and
 * "Shift lead" are the same name rather than two rows that look identical in a
 * list. Length is bounded by the column; the lower bound stops a whitespace-only
 * name becoming a role nobody can identify.
 */
const RoleNameSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/gu, ' '))
  .pipe(z.string().min(2, 'a role needs a name').max(50));

/**
 * The permission codes a role grants.
 *
 * Deduplicated at the edge rather than relied on downstream: the same code
 * twice is a client bug, not a request to refuse, and the subset check reads
 * more honestly against a set. Capped so a single request cannot ask for an
 * unbounded insert.
 */
const PermissionCodesSchema = z
  .array(z.string().trim().min(3).max(60))
  .max(200)
  .transform((codes) => [...new Set(codes)]);

/**
 * The level range a business may choose from.
 *
 * The owner's level is excluded by MAX_CREATABLE_ROLE_LEVEL, so "there is
 * exactly one top of the ladder" is refused at the edge as well as in the
 * authority rules. Two checks for one invariant, deliberately: this one gives a
 * clear validation error, and the other holds even if a future caller skips
 * the contract.
 */
const RoleLevelSchema = z.number().int().min(MIN_ROLE_LEVEL).max(MAX_CREATABLE_ROLE_LEVEL);
/*
 * NOT `z.coerce.number()`, which is the obvious choice and the wrong one here.
 * Coercion turns `null`, `[]` and `false` all into 0 — a real level, at the
 * bottom of the ladder. The direction is safe, but silently accepting malformed
 * input and inventing a level for it is not what an access-control field should
 * do. This arrives in a JSON body, where a number is a number.
 */

export const CreateRoleSchema = z
  .object({
    name: RoleNameSchema,
    description: z.string().trim().max(255).optional(),
    level: RoleLevelSchema,
    permissions: PermissionCodesSchema,
  })
  .strict();

/**
 * Editing a role replaces it wholesale rather than patching fields.
 *
 * A partial update of a permission SET is ambiguous — is an absent list "leave
 * it alone" or "grant nothing"? — and the difference between those two is a
 * silent, total revocation. The client sends what the role should be.
 */
export const UpdateRoleSchema = CreateRoleSchema;

export const SetEmployeeRolesSchema = z
  .object({
    /**
     * Exactly the roles this person should hold afterwards.
     *
     * At least one, because an employee with no roles can do nothing and is
     * indistinguishable from a half-finished invitation. Removing somebody's
     * access is what suspension is for, and it keeps the audit trail honest
     * about which of the two happened.
     */
    roleRefIds: z.array(z.uuid()).min(1).max(10),
  })
  .strict();

export type CreateRoleRequest = z.infer<typeof CreateRoleSchema>;
export type UpdateRoleRequest = z.infer<typeof UpdateRoleSchema>;
export type SetEmployeeRolesRequest = z.infer<typeof SetEmployeeRolesSchema>;
