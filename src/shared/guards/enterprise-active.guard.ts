import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { RequestContext } from '@/shared/context';
import { IS_PUBLIC_KEY, REQUIRED_PERMISSIONS_KEY } from '@/shared/decorators';
import { ActorKind, EnterpriseStatus } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';

/**
 * Gate 1b: is the business allowed to be used at all?
 *
 * A signup lands in `pending_activation` and stays there until somebody at
 * Wouchh switches it on, so this is what makes activation mean something. Without
 * it "activate" would be a label on a row that changed no behaviour.
 *
 * Checked per request rather than at login, because "suspend this business now"
 * has to take effect now — not whenever the access tokens already in the wild
 * happen to expire.
 *
 * The cost is one primary-key lookup of one column on tenant-scoped routes. That
 * is the price of the guarantee; the alternative was folding the status into the
 * permission query, which would have turned every one of these into an
 * indistinguishable "permission denied" for the business owner.
 *
 * STAFF ARE EXEMPT. Someone has to be able to look at a business in order to
 * decide whether to activate it.
 */
@Injectable()
export class EnterpriseActiveGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly enterprises: EnterpriseRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Only tenant-scoped routes declare permissions. Identity-scoped routes —
    // /auth/me, enterprise switching — must keep working for a pending business,
    // or its owner could not even see why they are blocked.
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const actor = RequestContext.actor();
    if (!actor) throw new AppException(ErrorCode.AuthTokenInvalid);
    if (actor.enterpriseId === null) return true; // EnterpriseScopeGuard's problem.
    if (actor.actorKind === ActorKind.Staff) return true;

    const status = await this.enterprises.statusById(actor.enterpriseId);
    if (status === null) throw new AppException(ErrorCode.EnterpriseNotFound);
    if (status === EnterpriseStatus.PendingActivation) {
      throw new AppException(ErrorCode.EnterprisePendingActivation);
    }
    if (status === EnterpriseStatus.Suspended) {
      throw new AppException(ErrorCode.EnterpriseSuspended);
    }

    return true;
  }
}
