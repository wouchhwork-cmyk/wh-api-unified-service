import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'wouchh:isPublic';

/**
 * Opts a route out of authentication.
 *
 * Guards are applied GLOBALLY and opened up per route rather than the reverse: a
 * route is protected unless it says otherwise, so forgetting a decorator fails
 * closed (backend-design.md §7.1).
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
