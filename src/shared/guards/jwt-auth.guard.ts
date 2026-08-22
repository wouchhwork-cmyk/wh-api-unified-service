import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RequestContext, type ActorContext } from '@/shared/context';
import { IS_PUBLIC_KEY } from '@/shared/decorators';
import { AppException, ErrorCode } from '@/shared/errors';
import { PermissionService } from '@/modules/auth/permission.service';
import { TokenService } from '@/modules/auth/token.service';

/**
 * Gate 0: is there a valid access token?
 *
 * Applied globally; bypassed only by @Public. It also builds the ActorContext
 * and puts it in the ambient request context, so it is the single place identity
 * enters the application.
 *
 * Guards AUTHORISE. They do not load business data and they never mutate
 * (backend-design.md §7.4).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(request);
    if (!token) throw new AppException(ErrorCode.AuthTokenInvalid);

    const claims = await this.tokens.verifyAccessToken(token);

    // Resolved per REQUEST, not per token: a role change takes effect on the
    // next request rather than the next login.
    const permissions = await this.permissions.resolve(claims);

    const actor: ActorContext = {
      identityId: claims.identityId,
      enterpriseId: claims.enterpriseId,
      memberId: claims.memberId,
      staffId: claims.staffId,
      actorKind: claims.actorKind,
      isImpersonated: claims.isImpersonated,
      permissions,
      correlationId: RequestContext.correlationId() ?? 'unknown',
    };

    RequestContext.setActor(actor);
    return true;
  }
}

/** Bearer only. A token in a query string would land in access logs. */
function extractBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim() || null;
}
