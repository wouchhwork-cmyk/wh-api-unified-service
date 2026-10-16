import { Injectable } from '@nestjs/common';
import { PermissionRepository } from '@/database/repositories/permission.repository';
import { ActorKind } from '@/shared/enums';
import type { AccessTokenClaims } from './token.service';

/**
 * Resolves the two-gate access check from schema.md into a permission set.
 *
 *   Gate 1 — does the enterprise have the feature?   (commercial)
 *   Gate 2 — do the employee's roles grant the action? (structural)
 *
 * Neither implies the other, which is why they are separate tables rather than
 * one grant.
 *
 * RESOLVED PER REQUEST, CACHED PER REQUEST — never per session. A role change
 * must take effect on the next request, not the next login. A short-TTL cache
 * keyed on (employeeId, rolesVersion) is permitted later, but only with an
 * explicit invalidation path (backend-design.md §7.2).
 */
@Injectable()
export class PermissionService {
  constructor(private readonly permissions: PermissionRepository) {}

  async resolve(claims: AccessTokenClaims): Promise<ReadonlySet<string>> {
    // A employee's own grants, when acting inside their business.
    if (claims.employeeId !== null && claims.enterpriseId !== null) {
      const codes = await this.permissions.listEffectivePermissions(
        claims.employeeId,
        claims.enterpriseId,
      );
      return new Set(codes);
    }

    /*
     * Staff bypass REACHES, it does not ENTITLE (schema.md §8): platform-wide
     * access grants entry into any enterprise, but a feature the enterprise
     * does not have still does not exist for anyone. So the set is every
     * staff-assignable permission whose feature this enterprise actually holds.
     */
    if (claims.actorKind === ActorKind.Staff && claims.staffId !== null) {
      const codes = await this.permissions.listStaffPermissions(
        claims.staffId,
        claims.enterpriseId,
      );
      return new Set(codes);
    }

    // Deny by default. No row means no permission; there are no negative grants
    // and therefore no precedence rules to get wrong.
    return new Set<string>();
  }
}
