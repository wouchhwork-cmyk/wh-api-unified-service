/** schema.md §9 — V1 catalogue. */
export enum FeatureKey {
  UnifiedInbox = 'unified_inbox',
  CommentManagement = 'comment_management',
  PostInsights = 'post_insights',
  CustomerDirectory = 'customer_directory',
}

export enum FeatureStatus {
  Active = 'active',
  Beta = 'beta',
  Deprecated = 'deprecated',
}

/**
 * schema.md §10 — the single source of truth for whether a feature is on.
 * There is deliberately no is_enabled boolean; `Active` is the only usable state.
 */
export enum EnterpriseFeatureStatus {
  AccessRequested = 'access_requested',
  Declined = 'declined',
  Active = 'active',
  Disabled = 'disabled',
  Expired = 'expired',
  Revoked = 'revoked',
}

/** The state machine from schema.md §10, as data so transitions are checkable. */
export const ENTERPRISE_FEATURE_TRANSITIONS: Readonly<
  Record<EnterpriseFeatureStatus, readonly EnterpriseFeatureStatus[]>
> = {
  [EnterpriseFeatureStatus.AccessRequested]: [
    EnterpriseFeatureStatus.Active,
    EnterpriseFeatureStatus.Declined,
  ],
  [EnterpriseFeatureStatus.Declined]: [EnterpriseFeatureStatus.AccessRequested],
  [EnterpriseFeatureStatus.Active]: [
    EnterpriseFeatureStatus.Disabled,
    EnterpriseFeatureStatus.Expired,
    EnterpriseFeatureStatus.Revoked,
  ],
  [EnterpriseFeatureStatus.Disabled]: [EnterpriseFeatureStatus.Active],
  [EnterpriseFeatureStatus.Expired]: [EnterpriseFeatureStatus.Active],
  /** Withdrawn by us — not self-serve re-enableable. */
  [EnterpriseFeatureStatus.Revoked]: [],
} as const;
