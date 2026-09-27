import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { REQUIRED_ANY_PERMISSION_KEY, REQUIRED_PERMISSIONS_KEY } from '@/shared/decorators';

/**
 * Does this route declare a permission, by EITHER decorator?
 *
 * Which is the same question as "is this route tenant-scoped?", and the answer
 * decides whether the scope and active-enterprise gates apply at all.
 *
 * IT LIVES HERE BECAUSE TWO GUARDS ASKED IT AND BOTH GOT IT WRONG THE SAME
 * WAY. Each read `@RequirePermission` and neither read
 * `@RequireAnyPermission`, so every route declaring its permissions the second
 * way — the whole inbox controller, eleven routes — skipped both gates.
 *
 * For EnterpriseScopeGuard that was survivable: an actor with no scope resolves
 * no permissions, so gate 2 refused them anyway. For EnterpriseActiveGuard it
 * was not. Nothing else checks that a business is still active, so a suspended
 * or not-yet-approved enterprise kept full read and reply access to its inbox.
 *
 * The lesson is the reason this is a function rather than two more copies: a
 * question asked in two places will eventually be answered differently in each,
 * and the second answer is the one nobody tests.
 */
export function declaresPermission(reflector: Reflector, context: ExecutionContext): boolean {
  const targets = [context.getHandler(), context.getClass()];

  const all = reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS_KEY, targets);
  if ((all?.length ?? 0) > 0) return true;

  const any = reflector.getAllAndOverride<string[]>(REQUIRED_ANY_PERMISSION_KEY, targets);
  return (any?.length ?? 0) > 0;
}
