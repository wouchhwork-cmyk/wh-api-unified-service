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
}

export enum AuditEntityType {
  Enterprise = 'enterprise',
  Identity = 'identity',
  EnterpriseEmployee = 'enterprise_employee',
  Role = 'role',
  EnterpriseFeature = 'enterprise_feature',
  ProviderConnection = 'provider_connection',
  Channel = 'channel',
  Customer = 'customer',
  Conversation = 'conversation',
  Message = 'message',
  Verification = 'verification',
}

export enum AuditStatus {
  Success = 'success',
  Failure = 'failure',
  Error = 'error',
}
