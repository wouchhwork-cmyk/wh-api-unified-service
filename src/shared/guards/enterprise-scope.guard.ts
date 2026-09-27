import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@/shared/context';
import {
  IS_PUBLIC_KEY,
  REQUIRED_ANY_PERMISSION_KEY,
  REQUIRED_PERMISSIONS_KEY,
} from '@/shared/decorators';
import { ActorKind } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';

/**
 * Gate 1: does the token carry an enterprise?
 *
 * Any route that declares a permission requirement is by definition operating on
 * tenant data, so it needs a scope. A staff actor who has not chosen a business
 * yet gets a clear 403 telling them to select one, rather than a confusing
 * empty result.
 */
@Injectable()
export class EnterpriseScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    /*
     * BOTH WAYS OF DECLARING A PERMISSION, because there are two.
     *
     * This read only `@RequirePermission` and every `@RequireAnyPermission`
     * route skipped this gate entirely — which is the whole inbox controller,
     * eleven routes. Nothing was exploitable: `@CurrentScopedActor` re-checks
     * the enterprise, and an actor with no scope resolves no permissions, so
     * gate 2 refuses them anyway. But the guard's stated invariant — "a route
     * that declares a permission is tenant-scoped and must have a scope" —
     * silently did not hold, and the next route written this way would have
     * inherited that.
     *
     * Two layers agreeing by accident is not defence in depth; it is one layer
     * and a coincidence.
     */
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredAny = this.reflector.getAllAndOverride<string[]>(REQUIRED_ANY_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const declaresPermission =
      (required?.length ?? 0) > 0 || (requiredAny?.length ?? 0) > 0;

    // No declared permission means the route is identity-scoped, not
    // tenant-scoped — /auth/me and enterprise switching, for instance.
    if (!declaresPermission) return true;

    const actor = RequestContext.actor();
    if (!actor) throw new AppException(ErrorCode.AuthTokenInvalid);

    if (actor.enterpriseId === null) {
      throw new AppException(ErrorCode.AuthEnterpriseNotSelected);
    }

    // A employee acting in their own business must actually have a employment.
    // Staff reach into an enterprise legitimately carries no employeeId.
    if (actor.employeeId === null && actor.actorKind !== ActorKind.Staff) {
      throw new AppException(ErrorCode.AuthNoActiveEmployment);
    }

    return true;
  }
}
