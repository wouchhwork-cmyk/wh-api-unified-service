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
  /*
   * ITS OWN ACTION, not `hidden` reused or `updated` as a catch-all.
   *
   * Recording an unhide as `hidden` is the same defect as recording a role
   * revocation as a grant: the row states the opposite of what happened, and
   * an auditor filtering on it is misled rather than merely underserved.
   */
  Unhidden = 'unhidden',
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
  /**
   * A rule granted value to a customer. No human decided it — a webhook
   * arrived, a rule matched, a worker applied it — so the actor is `system`.
   */
  Granted = 'granted',
  /** Value taken back after the content behind an award was removed or hidden. */
  Reversed = 'reversed',
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
   */
  RewardProgram = 'reward_program',
  RewardRule = 'reward_rule',
  /**
   * AN AWARD THE SYSTEM MADE BY ITSELF.
   *
   * This was deliberately left out once, on the argument that millions of rows
   * saying `system` would drown the handful that name a person. The premise was
   * right and the conclusion was wrong: granting a customer value IS an action
   * the platform took, and "why does this customer have 340 points" is a
   * question the trail has to answer whether or not a human was involved.
   *
   * The drowning is solved where it belongs — `audit_logs_human_idx` is partial
   * on `actor_kind <> 'system'`, so "what did people do" never pays for the
   * volume of what the engine did.
   */
  RewardAward = 'reward_award',
  /** A manual balance adjustment: a human moving value for one named customer. */
  RewardWallet = 'reward_wallet',
}

export enum AuditStatus {
  Success = 'success',
  Failure = 'failure',
  Error = 'error',
}
