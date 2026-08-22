import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PLATFORM_ADMIN_KEY = 'wouchh:requirePlatformAdmin';

/**
 * Marks a route as part of the internal platform surface: Wouchh's own staff
 * looking across every business on the platform.
 *
 * Deliberately NOT expressed as a permission. Permissions are granted by roles
 * that live inside an enterprise, and are gated by what that enterprise has
 * bought — the wrong shape entirely for "this person works for us". Keeping it a
 * separate axis also means no enterprise-side role edit can ever grant platform
 * reach, however the role tables are configured.
 */
export const RequirePlatformAdmin = (): MethodDecorator =>
  SetMetadata(REQUIRE_PLATFORM_ADMIN_KEY, true);
