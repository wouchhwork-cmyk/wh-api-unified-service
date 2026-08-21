/**
 * schema.md §2 — account-wide state. A throttle lock is deliberately NOT a
 * status: `locked_until` carries it, because it expires on its own and a stored
 * `locked` would need a sweep to unset.
 */
export enum IdentityStatus {
  Active = 'active',
  Disabled = 'disabled',
}

/** schema.md §3 */
export enum MemberStatus {
  Invited = 'invited',
  Active = 'active',
  Suspended = 'suspended',
}

/** schema.md §4 */
export enum StaffStatus {
  Active = 'active',
  Suspended = 'suspended',
}

/** schema.md §1 */
export enum EnterpriseStatus {
  Active = 'active',
  Suspended = 'suspended',
}

/** schema.md §5 — keeps a staff role from ever being handed to a business member. */
export enum RoleScope {
  Enterprise = 'enterprise',
  Staff = 'staff',
}

/** schema.md §5 */
export enum RoleStatus {
  Active = 'active',
  Archived = 'archived',
}

/** schema.md §6 — `both` means the permission is assignable in either scope. */
export enum PermissionScope {
  Enterprise = 'enterprise',
  Staff = 'staff',
  Both = 'both',
}

/** schema.md §6 */
export enum PermissionStatus {
  Active = 'active',
  Deprecated = 'deprecated',
}
