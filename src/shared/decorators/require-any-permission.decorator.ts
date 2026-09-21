import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@/shared/enums';

export const REQUIRED_ANY_PERMISSION_KEY = 'wouchh:requiredAnyPermission';

/**
 * Declares permission codes of which the actor needs AT LEAST ONE.
 *
 * The opposite of `@RequirePermission`, which ANDs. It exists for one shape:
 * an endpoint that serves several kinds of thing governed by different codes.
 * The inbox is that endpoint — one set of routes serves direct messages,
 * comment threads and mentions, and a business granting only `mentions.view`
 * must still be able to reach the endpoint that serves mentions.
 *
 * IT IS A DOOR, NOT A DECISION. Passing this guard means the actor may reach
 * the handler, never that they may touch the row the handler finds. The service
 * makes the precise check once it knows which kind it is looking at — see
 * `conversation-permissions.ts`. Using this where `@RequirePermission` would do
 * is a widening, so it is deliberately awkward to reach for: there is no
 * overload, and the union has to be written out or produced by
 * `anyPermissionFor`.
 */
export const RequireAnyPermission = (...permissions: Permission[]): MethodDecorator =>
  SetMetadata(REQUIRED_ANY_PERMISSION_KEY, permissions);
