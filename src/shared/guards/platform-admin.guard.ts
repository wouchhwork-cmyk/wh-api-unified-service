import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StaffMemberRepository } from '@/database/repositories/staff-member.repository';
import { RequestContext } from '@/shared/context';
import { IS_PUBLIC_KEY, REQUIRE_PLATFORM_ADMIN_KEY } from '@/shared/decorators';
import { AppException, ErrorCode } from '@/shared/errors';

/**
 * Gate 3: is the caller one of our own people, with platform-wide reach?
 *
 * Re-read from the database on every request rather than trusted from the token.
 * An access token lives for minutes, and "revoke this admin now" has to mean now
 * — not "when their token expires". This is the highest-privilege surface in the
 * product, and it is low traffic, so one indexed lookup is the right trade.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly staff: StaffMemberRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_PLATFORM_ADMIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const actor = RequestContext.actor();
    if (!actor) throw new AppException(ErrorCode.AuthTokenInvalid);

    // A token can claim a staffId; only the row can prove it is still valid.
    if (actor.staffId === null) throw new AppException(ErrorCode.PermissionDenied);

    const record = await this.staff.findActiveByIdentity(actor.identityId);
    if (!record || record.staffId !== actor.staffId || !record.hasAllEnterpriseAccess) {
      throw new AppException(ErrorCode.PermissionDenied);
    }

    return true;
  }
}
