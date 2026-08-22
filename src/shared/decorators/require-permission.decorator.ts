import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@/shared/enums';

export const REQUIRED_PERMISSIONS_KEY = 'wouchh:requiredPermissions';

/**
 * Declares the permission codes a route needs. All listed codes must be held —
 * ANDed, not ORed, because an endpoint that touches two resources needs rights
 * to both.
 */
export const RequirePermission = (...permissions: Permission[]): MethodDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
