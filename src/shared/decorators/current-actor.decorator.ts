import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { RequestContext, type ActorContext } from '@/shared/context';
import { AppException, ErrorCode } from '@/shared/errors';

/**
 * Injects the resolved ActorContext.
 *
 * Read from the ambient request context, which the guard chain populated — never
 * reconstructed from a request body, because a client-supplied enterpriseId is
 * the classic tenant-escape vector.
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, _context: ExecutionContext): ActorContext => {
    const actor = RequestContext.actor();
    if (!actor) {
      // Reaching a handler with no actor means the guard chain was bypassed —
      // a wiring bug, and failing loudly is the only safe response.
      throw new AppException(ErrorCode.AuthTokenInvalid, {
        message: 'No authenticated actor on this request.',
      });
    }
    return actor;
  },
);

/** For endpoints that must have an enterprise: narrows enterpriseId to number. */
export const CurrentScopedActor = createParamDecorator(
  (_data: unknown, _context: ExecutionContext): ActorContext & { enterpriseId: number } => {
    const actor = RequestContext.actor();
    if (!actor) throw new AppException(ErrorCode.AuthTokenInvalid);
    if (actor.enterpriseId === null) throw new AppException(ErrorCode.AuthEnterpriseNotSelected);
    return actor as ActorContext & { enterpriseId: number };
  },
);
