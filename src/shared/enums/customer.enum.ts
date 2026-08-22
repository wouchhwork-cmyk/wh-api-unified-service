/** schema.md §17 — every way a customer can be recognised or reached. */
export enum IdentifierKind {
  Email = 'email',
  Mobile = 'mobile',
  /** App-scoped, so the same human has a different value per enterprise. */
  InstagramUserId = 'instagram_user_id',
  InstagramUsername = 'instagram_username',
  /** Page-scoped id (PSID) — also differs per enterprise. */
  FacebookUserId = 'facebook_user_id',
  WhatsAppNumber = 'whatsapp_number',
  /** The enterprise's own CRM reference. */
  ExternalRef = 'external_ref',
}

/**
 * The kinds that hold a HANDLE rather than an opaque id.
 *
 * A list rather than a single value because every platform added later brings
 * its own — and because the directory searches all of them at once.
 */
export const HANDLE_IDENTIFIER_KINDS: readonly IdentifierKind[] = [
  IdentifierKind.InstagramUsername,
] as const;

/** The kinds stored as a decomposed phone number (schema.md phone storage). */
export const PHONE_IDENTIFIER_KINDS: readonly IdentifierKind[] = [
  IdentifierKind.Mobile,
  IdentifierKind.WhatsAppNumber,
] as const;

/**
 * schema.md §17 — `released` is what makes identifier recycling possible: a
 * carrier reassigns a number, the old row is released, and the value becomes
 * claimable again. `invalid` deliberately lives only on verification_status,
 * so one fact is never asserted by two columns.
 */
export enum IdentifierStatus {
  Active = 'active',
  Released = 'released',
}

export enum IdentifierSource {
  Platform = 'platform',
  SelfDeclared = 'self_declared',
  Import = 'import',
  AgentEntered = 'agent_entered',
}

/** schema.md §17 — verification is per enterprise, always. */
export enum IdentifierVerificationStatus {
  Unverified = 'unverified',
  Pending = 'pending',
  Verified = 'verified',
  Failed = 'failed',
  Bounced = 'bounced',
  Invalid = 'invalid',
}

export enum IdentifierVerificationMethod {
  OtpSms = 'otp_sms',
  OtpEmail = 'otp_email',
  PlatformProvided = 'platform_provided',
  AgentConfirmed = 'agent_confirmed',
}

/**
 * schema.md §16 — how we FIRST met a customer. Immutable: this is attribution,
 * not current state. Where they engage now is customer_engagements (§18).
 */
export enum CustomerFirstSource {
  InstagramDm = 'instagram_dm',
  FacebookComment = 'facebook_comment',
  InstagramComment = 'instagram_comment',
  FacebookDm = 'facebook_dm',
  Import = 'import',
  Manual = 'manual',
}

/** schema.md §16 — the single source of truth for whether a customer is blocked. */
export enum CustomerStatus {
  Active = 'active',
  Blocked = 'blocked',
  Merged = 'merged',
  PlatformDeleted = 'platform_deleted',
}
