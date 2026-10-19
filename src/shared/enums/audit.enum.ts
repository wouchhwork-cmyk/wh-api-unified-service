/** schema.md §25 */
export enum AuditAction {
  Created = 'created',
  Updated = 'updated',
  Deleted = 'deleted',
  Login = 'login',
  LoginFailed = 'login_failed',
  Logout = 'logout',
  Verified = 'verified',
  Connected = 'connected',
  Disconnected = 'disconnected',
  Replied = 'replied',
  Assigned = 'assigned',
  Hidden = 'hidden',
  RoleGranted = 'role_granted',
  RoleRevoked = 'role_revoked',
  FeatureRequested = 'feature_requested',
  FeatureDecided = 'feature_decided',
  /** One of ours entered a customer's account. See AuditService.record. */
  Impersonated = 'impersonated',
  /** One of ours read a customer's account from the platform console. */
  Viewed = 'viewed',
  /**
   * A manual credit or debit against one customer's reward balance.
   *
   * Its own action rather than `updated`, because the audit question here is
   * not "what changed" but "who moved money, for whom, and why".
   */
  Adjusted = 'adjusted',
}

export enum AuditEntityType {
  Enterprise = 'enterprise',
  Identity = 'identity',
  EnterpriseEmployee = 'enterprise_employee',
  /** One of ours, not a business's. Staff role grants are recorded against it. */
  StaffMember = 'staff_member',
  Role = 'role',
  EnterpriseFeature = 'enterprise_feature',
  ProviderConnection = 'provider_connection',
  Channel = 'channel',
  Customer = 'customer',
  Conversation = 'conversation',
  Message = 'message',
  Verification = 'verification',
  /*
   * REWARD PROGRAMS. A rule decides who receives value, so editing one is a
   * money decision.
   *
   * Only the CONFIG is audited. An award has no human actor — it is caused by a
   * rule, from a webhook, in a worker — and AuditService falls back to
   * ActorKind.System where there is no request context. Auditing awards would
   * produce millions of rows all saying `system`, drowning the handful that
   * name a person. The ledger's provenance is the system-caused trail.
   */
  RewardProgram = 'reward_program',
  RewardRule = 'reward_rule',
  /** A manual balance adjustment: a human moving value for one named customer. */
  RewardWallet = 'reward_wallet',
}

export enum AuditStatus {
  Success = 'success',
  Failure = 'failure',
  Error = 'error',
}
