import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@/shared/context';
import { IS_PUBLIC_KEY, REQUIRED_PERMISSIONS_KEY } from '@/shared/decorators';
import { AppException, ErrorCode } from '@/shared/errors';

/**
 * Gate 2: do the actor's resolved permissions include everything the route
 * declares?
 *
 * The two-gate rule (enterprise has the feature AND the roles grant the action)
 * is already applied when the set was resolved, so this is a pure set check.
 *
 * DENY BY DEFAULT: an empty set passes nothing. There are no negative grants,
 * so there is no precedence puzzle to get wrong.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const actor = RequestContext.actor();
    if (!actor) throw new AppException(ErrorCode.AuthTokenInvalid);

    const missing = required.filter((permission) => !actor.permissions.has(permission));
    if (missing.length > 0) {
      // Naming the missing codes is deliberate: they are not secrets, and a
      // client author otherwise learns them only by trial and error. No
      // internal ids are exposed.
      throw new AppException(ErrorCode.PermissionDenied, {
        details: missing.map((permission) => ({ field: 'permission', issue: permission })),
      });
    }

    return true;
  }
}
