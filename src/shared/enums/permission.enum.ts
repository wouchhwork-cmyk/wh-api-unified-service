/** schema.md §6 — the resource half of a `<resource>.<action>` code. */
export enum PermissionResource {
  Conversations = 'conversations',
  Comments = 'comments',
  Posts = 'posts',
  Channels = 'channels',
  Customers = 'customers',
  Employees = 'employees',
  Roles = 'roles',
  Features = 'features',
  Enterprise = 'enterprise',
}

/** The action half. */
export enum PermissionAction {
  View = 'view',
  Reply = 'reply',
  Assign = 'assign',
  Delete = 'delete',
  Hide = 'hide',
  Connect = 'connect',
  Manage = 'manage',
  Invite = 'invite',
  Request = 'request',
  /** Staff-side approval or refusal of an enterprise's feature request. */
  Decide = 'decide',
}

/**
 * The permission codes as they appear in @RequirePermission and in API errors.
 * `code` is redundant with resource+action by construction and kept because it
 * is the string every call site uses (schema.md §6).
 */
export enum Permission {
  ConversationsView = 'conversations.view',
  ConversationsReply = 'conversations.reply',
  ConversationsAssign = 'conversations.assign',
  ConversationsManage = 'conversations.manage',

  CommentsView = 'comments.view',
  CommentsReply = 'comments.reply',
  CommentsHide = 'comments.hide',
  CommentsDelete = 'comments.delete',

  PostsView = 'posts.view',

  ChannelsView = 'channels.view',
  ChannelsConnect = 'channels.connect',
  ChannelsManage = 'channels.manage',

  CustomersView = 'customers.view',
  CustomersManage = 'customers.manage',

  EmployeesView = 'employees.view',
  EmployeesInvite = 'employees.invite',
  EmployeesManage = 'employees.manage',

  RolesView = 'roles.view',
  RolesManage = 'roles.manage',

  FeaturesView = 'features.view',
  FeaturesRequest = 'features.request',
  /** Staff-scoped: approving or declining an enterprise's feature request. */
  FeaturesDecide = 'features.decide',

  EnterpriseView = 'enterprise.view',
  EnterpriseManage = 'enterprise.manage',
}

/** The seeded system role names (schema.md §8). */
export enum SystemRole {
  Owner = 'owner',
  Manager = 'manager',
  Agent = 'agent',
  Viewer = 'viewer',
  Support = 'support',
  Ops = 'ops',
}

/**
 * How much authority a role carries, as a number a query can compare.
 *
 * HIGHER MEANS MORE, 0 to 100. That direction is chosen deliberately: the rule
 * people state out loud is "you may only create roles BELOW your level", and
 * with the scale inverted every read of that sentence has to be mentally
 * flipped. It also makes the SQL say what it means — `role.level < $actorLevel`.
 *
 * The values are spread rather than dense (1,2,3,4) so a business can insert
 * `Senior agent` at 55 without renumbering anything that already exists. A
 * dense ladder makes every new rung a migration.
 *
 * WHY A NUMBER AND NOT A PARENT LINK. A tree would let a business express
 * "reports to" as well as "outranks", and nothing in the product needs the
 * first. A tree also makes every check a recursive query, and the check runs on
 * the path of every grant.
 */
export const ROLE_LEVEL = {
  /** Total control, including billing. Reserved: no API path creates one. */
  Owner: 100,
  Manager: 70,
  Agent: 40,
  Viewer: 10,
} as const;

/** The seeded roles' levels, and the backfill for any row that predates them. */
export const SYSTEM_ROLE_LEVELS: Readonly<Record<SystemRole, number>> = {
  [SystemRole.Owner]: ROLE_LEVEL.Owner,
  [SystemRole.Manager]: ROLE_LEVEL.Manager,
  [SystemRole.Agent]: ROLE_LEVEL.Agent,
  [SystemRole.Viewer]: ROLE_LEVEL.Viewer,
  /*
   * The two staff roles. Ungrantable today (see rbac-plan.md §2.4) but levelled
   * now so that making them real later is not also a levelling exercise: `ops`
   * administers connections, `support` reads and replies.
   */
  [SystemRole.Support]: ROLE_LEVEL.Agent,
  [SystemRole.Ops]: ROLE_LEVEL.Manager,
};

/**
 * The lowest level a role may carry, and the highest anyone may CREATE.
 *
 * The owner's level is excluded from the assignable range on purpose. Only the
 * seed produces a role at 100, so "there is exactly one top of the ladder"
 * holds by construction rather than by a check somebody can forget — and a
 * business cannot mint a second full-control role and then grant it to escape
 * the owner rules.
 */
export const MIN_ROLE_LEVEL = 0;
export const MAX_CREATABLE_ROLE_LEVEL = ROLE_LEVEL.Owner - 1;

/**
 * An employee's authority: the HIGHEST level among the roles they hold.
 *
 * Max rather than min, because roles are additive — holding `agent` as well as
 * `manager` cannot make somebody less senior than holding `manager` alone, and
 * taking the minimum would mean granting an extra role could silently demote
 * a person.
 *
 * NOBODY IS THE DEFAULT. An employee with no roles gets `null`, not 0: zero is
 * a real level that outranks nothing but still compares, and treating "no roles
 * yet" as a real position on the ladder is how an invited-but-unaccepted
 * employee ends up able to act.
 */
export function highestRoleLevel(levels: readonly number[]): number | null {
  return levels.length === 0 ? null : Math.max(...levels);
}
