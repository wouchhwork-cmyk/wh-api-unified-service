/**
 * The machine-readable error catalogue (backend-design.md §8.2).
 *
 * Adding a code is backward compatible; changing or removing one is BREAKING,
 * because these strings are part of the public contract that clients branch on.
 */
export enum ErrorCode {
  // --- authentication ---------------------------------------------------
  AuthInvalidCredentials = 'AUTH_INVALID_CREDENTIALS',
  AuthCodeInvalid = 'AUTH_CODE_INVALID',
  AuthCodeExpired = 'AUTH_CODE_EXPIRED',
  AuthCodeAttemptsExceeded = 'AUTH_CODE_ATTEMPTS_EXCEEDED',
  AuthCodeAlreadyUsed = 'AUTH_CODE_ALREADY_USED',
  AuthAccountLocked = 'AUTH_ACCOUNT_LOCKED',
  AuthAccountDisabled = 'AUTH_ACCOUNT_DISABLED',
  AuthTokenInvalid = 'AUTH_TOKEN_INVALID',
  AuthTokenExpired = 'AUTH_TOKEN_EXPIRED',
  AuthSessionRevoked = 'AUTH_SESSION_REVOKED',
  AuthResendTooSoon = 'AUTH_RESEND_TOO_SOON',
  /** Authenticated, but no active business — 403, not 401. */
  AuthNoActiveEmployment = 'AUTH_NO_ACTIVE_EMPLOYMENT',
  AuthEnterpriseNotSelected = 'AUTH_ENTERPRISE_NOT_SELECTED',

  // --- authorisation ----------------------------------------------------
  PermissionDenied = 'PERMISSION_DENIED',
  FeatureNotEnabled = 'FEATURE_NOT_ENABLED',
  EnterpriseSuspended = 'ENTERPRISE_SUSPENDED',

  // --- validation -------------------------------------------------------
  ValidationFailed = 'VALIDATION_FAILED',
  InvalidEmail = 'INVALID_EMAIL',
  InvalidMobile = 'INVALID_MOBILE',
  CredentialRequired = 'CREDENTIAL_REQUIRED',

  // --- conflicts --------------------------------------------------------
  EmailAlreadyRegistered = 'EMAIL_ALREADY_REGISTERED',
  MobileAlreadyRegistered = 'MOBILE_ALREADY_REGISTERED',
  EnterpriseSlugTaken = 'ENTERPRISE_SLUG_TAKEN',
  EnterpriseEmailAlreadyRegistered = 'ENTERPRISE_EMAIL_ALREADY_REGISTERED',
  EmployeeAlreadyExists = 'EMPLOYEE_ALREADY_EXISTS',
  RoleNameTaken = 'ROLE_NAME_TAKEN',
  IdentifierAlreadyLinked = 'IDENTIFIER_ALREADY_LINKED',
  DuplicateMessage = 'DUPLICATE_MESSAGE',
  SyncAlreadyRunning = 'SYNC_ALREADY_RUNNING',
  FeatureAlreadyRequested = 'FEATURE_ALREADY_REQUESTED',
  InvalidStateTransition = 'INVALID_STATE_TRANSITION',
  /**
   * Somebody else changed the row between our read and our write. The client's
   * view is stale, so it should refetch and decide again — never blind-retry.
   */
  ConcurrentModification = 'CONCURRENT_MODIFICATION',
  /** Signed up and verified, but not yet switched on by Wouchh. */
  EnterprisePendingActivation = 'ENTERPRISE_PENDING_ACTIVATION',

  /**
   * A provider we recognise but have not implemented. Distinct from a validation
   * failure: the caller asked for something legitimate that does not exist yet,
   * which is our gap and not their mistake.
   */
  ProviderNotSupported = 'PROVIDER_NOT_SUPPORTED',

  // --- not found --------------------------------------------------------
  /** An unknown route. Distinct from a missing domain entity. */
  RouteNotFound = 'ROUTE_NOT_FOUND',
  EnterpriseNotFound = 'ENTERPRISE_NOT_FOUND',
  EmployeeNotFound = 'EMPLOYEE_NOT_FOUND',
  RoleNotFound = 'ROLE_NOT_FOUND',
  FeatureNotFound = 'FEATURE_NOT_FOUND',
  ConnectionNotFound = 'CONNECTION_NOT_FOUND',
  ChannelNotFound = 'CHANNEL_NOT_FOUND',
  CustomerNotFound = 'CUSTOMER_NOT_FOUND',
  ConversationNotFound = 'CONVERSATION_NOT_FOUND',
  MessageNotFound = 'MESSAGE_NOT_FOUND',
  PostNotFound = 'POST_NOT_FOUND',
  VerificationNotFound = 'VERIFICATION_NOT_FOUND',

  // --- domain -----------------------------------------------------------
  ChannelReauthRequired = 'CHANNEL_REAUTH_REQUIRED',
  ChannelNotManaged = 'CHANNEL_NOT_MANAGED',
  /** Meta's 24-hour messaging window has closed — proven mapping, §18.3. */
  MessagingWindowClosed = 'MESSAGING_WINDOW_CLOSED',
  CustomerBlocked = 'CUSTOMER_BLOCKED',
  ConversationClosed = 'CONVERSATION_CLOSED',
  /** The platform offers no way to answer this kind of item — a review, today. */
  ReplyNotSupported = 'REPLY_NOT_SUPPORTED',

  // --- integration ------------------------------------------------------
  MetaNotConfigured = 'META_NOT_CONFIGURED',
  OauthStateInvalid = 'OAUTH_STATE_INVALID',
  OauthDenied = 'OAUTH_DENIED',
  OauthExchangeFailed = 'OAUTH_EXCHANGE_FAILED',
  WebhookSignatureInvalid = 'WEBHOOK_SIGNATURE_INVALID',
  NoPagesFound = 'NO_PAGES_FOUND',

  // --- infrastructure ---------------------------------------------------
  RateLimited = 'RATE_LIMITED',
  UpstreamUnavailable = 'UPSTREAM_UNAVAILABLE',
  UpstreamRateLimited = 'UPSTREAM_RATE_LIMITED',
  RequestTimeout = 'REQUEST_TIMEOUT',
  PayloadTooLarge = 'PAYLOAD_TOO_LARGE',
  InternalError = 'INTERNAL_ERROR',
}
