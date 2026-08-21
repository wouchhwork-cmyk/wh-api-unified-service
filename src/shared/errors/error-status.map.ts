import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes.enum';

/**
 * ONE table maps a code to a status, so a status is never chosen ad hoc at a
 * throw site (backend-design.md §8.2). Every code appears exactly once — the
 * exhaustive Record type makes a missing entry a compile error.
 */
export const ERROR_STATUS: Readonly<Record<ErrorCode, HttpStatus>> = {
  // 401 — who are you
  [ErrorCode.AuthInvalidCredentials]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.AuthCodeInvalid]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.AuthCodeExpired]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.AuthCodeAttemptsExceeded]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.AuthCodeAlreadyUsed]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.AuthTokenInvalid]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.AuthTokenExpired]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.AuthSessionRevoked]: HttpStatus.UNAUTHORIZED,

  // 403 — authenticated, but not allowed
  [ErrorCode.AuthNoActiveMembership]: HttpStatus.FORBIDDEN,
  [ErrorCode.AuthEnterpriseNotSelected]: HttpStatus.FORBIDDEN,
  [ErrorCode.AuthAccountLocked]: HttpStatus.FORBIDDEN,
  [ErrorCode.AuthAccountDisabled]: HttpStatus.FORBIDDEN,
  [ErrorCode.PermissionDenied]: HttpStatus.FORBIDDEN,
  [ErrorCode.FeatureNotEnabled]: HttpStatus.FORBIDDEN,
  [ErrorCode.EnterpriseSuspended]: HttpStatus.FORBIDDEN,
  [ErrorCode.WebhookSignatureInvalid]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.OauthStateInvalid]: HttpStatus.FORBIDDEN,

  // 404
  [ErrorCode.RouteNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.EnterpriseNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.MemberNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.RoleNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.FeatureNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.ConnectionNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.ChannelNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.CustomerNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.ConversationNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.MessageNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.PostNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.VerificationNotFound]: HttpStatus.NOT_FOUND,

  // 409 — conflicts and invalid transitions
  [ErrorCode.EmailAlreadyRegistered]: HttpStatus.CONFLICT,
  [ErrorCode.MobileAlreadyRegistered]: HttpStatus.CONFLICT,
  [ErrorCode.EnterpriseSlugTaken]: HttpStatus.CONFLICT,
  [ErrorCode.MemberAlreadyExists]: HttpStatus.CONFLICT,
  [ErrorCode.RoleNameTaken]: HttpStatus.CONFLICT,
  [ErrorCode.IdentifierAlreadyLinked]: HttpStatus.CONFLICT,
  [ErrorCode.DuplicateMessage]: HttpStatus.CONFLICT,
  [ErrorCode.SyncAlreadyRunning]: HttpStatus.CONFLICT,
  [ErrorCode.FeatureAlreadyRequested]: HttpStatus.CONFLICT,
  [ErrorCode.InvalidStateTransition]: HttpStatus.CONFLICT,
  [ErrorCode.MessagingWindowClosed]: HttpStatus.CONFLICT,
  [ErrorCode.CustomerBlocked]: HttpStatus.CONFLICT,
  [ErrorCode.ConversationClosed]: HttpStatus.CONFLICT,
  [ErrorCode.ChannelReauthRequired]: HttpStatus.CONFLICT,
  [ErrorCode.ChannelNotManaged]: HttpStatus.CONFLICT,

  // 422 — the request was understood but is not valid
  [ErrorCode.ValidationFailed]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.InvalidEmail]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.InvalidMobile]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.CredentialRequired]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.OauthDenied]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.NoPagesFound]: HttpStatus.UNPROCESSABLE_ENTITY,

  // 429
  [ErrorCode.RateLimited]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorCode.AuthResendTooSoon]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorCode.UpstreamRateLimited]: HttpStatus.TOO_MANY_REQUESTS,

  // 4xx misc
  [ErrorCode.PayloadTooLarge]: HttpStatus.PAYLOAD_TOO_LARGE,
  [ErrorCode.RequestTimeout]: HttpStatus.REQUEST_TIMEOUT,

  // 5xx
  [ErrorCode.MetaNotConfigured]: HttpStatus.SERVICE_UNAVAILABLE,
  [ErrorCode.OauthExchangeFailed]: HttpStatus.BAD_GATEWAY,
  [ErrorCode.UpstreamUnavailable]: HttpStatus.BAD_GATEWAY,
  [ErrorCode.InternalError]: HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * Client-safe messages. Deliberately generic where an attacker could learn
 * something: every credential failure reads the same, so the endpoint is not an
 * account-enumeration oracle (schema.md §11–12).
 */
export const ERROR_MESSAGE: Readonly<Record<ErrorCode, string>> = {
  [ErrorCode.AuthInvalidCredentials]: 'The email, mobile, or password is incorrect.',
  [ErrorCode.AuthCodeInvalid]: 'That code is not correct.',
  [ErrorCode.AuthCodeExpired]: 'That code has expired. Request a new one.',
  [ErrorCode.AuthCodeAttemptsExceeded]: 'Too many incorrect attempts. Request a new code.',
  [ErrorCode.AuthCodeAlreadyUsed]: 'That code has already been used.',
  [ErrorCode.AuthAccountLocked]: 'This account is temporarily locked. Try again later.',
  [ErrorCode.AuthAccountDisabled]: 'This account has been disabled.',
  [ErrorCode.AuthTokenInvalid]: 'Your session is not valid. Sign in again.',
  [ErrorCode.AuthTokenExpired]: 'Your session has expired. Sign in again.',
  [ErrorCode.AuthSessionRevoked]: 'This session has been signed out.',
  [ErrorCode.AuthResendTooSoon]: 'Please wait before requesting another code.',
  [ErrorCode.AuthNoActiveMembership]: 'This account has no active business.',
  [ErrorCode.AuthEnterpriseNotSelected]: 'Select a business before continuing.',

  [ErrorCode.PermissionDenied]: 'You do not have permission to do that.',
  [ErrorCode.FeatureNotEnabled]: 'That feature is not enabled for this business.',
  [ErrorCode.EnterpriseSuspended]: 'This business account is suspended.',

  [ErrorCode.ValidationFailed]: 'Some of the values sent are not valid.',
  [ErrorCode.InvalidEmail]: 'That email address is not valid.',
  [ErrorCode.InvalidMobile]: 'That mobile number is not valid for the country given.',
  [ErrorCode.CredentialRequired]: 'An email address or a mobile number is required.',

  [ErrorCode.EmailAlreadyRegistered]: 'An account already exists for that email address.',
  [ErrorCode.MobileAlreadyRegistered]: 'An account already exists for that mobile number.',
  [ErrorCode.EnterpriseSlugTaken]: 'That business URL is already taken.',
  [ErrorCode.MemberAlreadyExists]: 'That person is already a member of this business.',
  [ErrorCode.RoleNameTaken]: 'A role with that name already exists.',
  [ErrorCode.IdentifierAlreadyLinked]: 'That contact detail is already linked to another customer.',
  [ErrorCode.DuplicateMessage]: 'That message has already been sent.',
  [ErrorCode.SyncAlreadyRunning]: 'A sync of that kind is already running for this channel.',
  [ErrorCode.FeatureAlreadyRequested]: 'That feature has already been requested.',
  [ErrorCode.InvalidStateTransition]: 'That change is not allowed from the current state.',

  [ErrorCode.RouteNotFound]: 'That endpoint does not exist.',
  [ErrorCode.EnterpriseNotFound]: 'Business not found.',
  [ErrorCode.MemberNotFound]: 'Member not found.',
  [ErrorCode.RoleNotFound]: 'Role not found.',
  [ErrorCode.FeatureNotFound]: 'Feature not found.',
  [ErrorCode.ConnectionNotFound]: 'Connection not found.',
  [ErrorCode.ChannelNotFound]: 'Channel not found.',
  [ErrorCode.CustomerNotFound]: 'Customer not found.',
  [ErrorCode.ConversationNotFound]: 'Conversation not found.',
  [ErrorCode.MessageNotFound]: 'Message not found.',
  [ErrorCode.PostNotFound]: 'Post not found.',
  [ErrorCode.VerificationNotFound]: 'That verification request could not be found.',

  [ErrorCode.ChannelReauthRequired]: 'This channel needs to be reconnected before you can reply.',
  [ErrorCode.ChannelNotManaged]: 'This channel is not being managed.',
  [ErrorCode.MessagingWindowClosed]:
    'The 24-hour messaging window for this conversation has closed.',
  [ErrorCode.CustomerBlocked]: 'This customer is blocked.',
  [ErrorCode.ConversationClosed]: 'This conversation is closed.',

  [ErrorCode.MetaNotConfigured]: 'The Meta integration is not configured on this environment.',
  [ErrorCode.OauthStateInvalid]: 'That connection request is no longer valid. Start again.',
  [ErrorCode.OauthDenied]: 'The connection was cancelled.',
  [ErrorCode.OauthExchangeFailed]: 'Could not complete the connection with the provider.',
  [ErrorCode.WebhookSignatureInvalid]: 'Invalid signature.',
  [ErrorCode.NoPagesFound]: 'No Pages were found on that account.',

  [ErrorCode.RateLimited]: 'Too many requests. Slow down.',
  [ErrorCode.UpstreamUnavailable]: 'The provider is unavailable. Try again shortly.',
  [ErrorCode.UpstreamRateLimited]: 'The provider is rate limiting us. Try again shortly.',
  [ErrorCode.RequestTimeout]: 'The request took too long.',
  [ErrorCode.PayloadTooLarge]: 'That request is too large.',
  // Never leaks the cause; the stack goes to the log under the same requestId.
  [ErrorCode.InternalError]: 'Something went wrong on our side.',
};
