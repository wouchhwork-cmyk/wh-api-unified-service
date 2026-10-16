import { SetMetadata } from '@nestjs/common';

export const SKIP_TIMEOUT_KEY = 'wouchh:skipTimeout';

/**
 * Exempts a route from the global request timeout.
 *
 * For the rare handler whose work legitimately outlasts a normal request. The
 * OAuth callback is the case that forced this: it makes four mandatory Graph
 * calls in series, then one per discovered Page, and each has its own 10-second
 * budget — so the 15-second global timeout could abort it halfway. Aborting
 * there is the worst outcome available, because the connection may be half
 * written and the person is told it failed.
 *
 * Use sparingly. A route with no time bound at all is how a slow provider
 * becomes a thread-pool incident; every exempted handler must have its own
 * per-call timeouts, which the Graph client does.
 */
export const SkipTimeout = (): MethodDecorator => SetMetadata(SKIP_TIMEOUT_KEY, true);
