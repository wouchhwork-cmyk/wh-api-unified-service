/** schema.md §6 — the resource half of a `<resource>.<action>` code. */
export enum PermissionResource {
  Conversations = 'conversations',
  Comments = 'comments',
  Posts = 'posts',
  Channels = 'channels',
  Customers = 'customers',
  Members = 'members',
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

  MembersView = 'members.view',
  MembersInvite = 'members.invite',
  MembersManage = 'members.manage',

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
