/**
 * schema.md §12 — one verifications table, this column is the discriminator.
 * Each kind carries its own secret shape, expiry, and attempt budget in config.
 */
export enum VerificationKind {
  FirstLogin = 'first_login',
  EmailVerification = 'email_verification',
  MobileVerification = 'mobile_verification',
  PasswordReset = 'password_reset',
  EmployeeInvite = 'employee_invite',
  IdentifierChange = 'identifier_change',
  CustomerMobileVerification = 'customer_mobile_verification',
  CustomerEmailVerification = 'customer_email_verification',
}

/** schema.md §12 — polymorphic subject: an identity today, a customer later. */
export enum VerificationSubjectKind {
  Identity = 'identity',
  Customer = 'customer',
}

export enum DeliveryChannel {
  Email = 'email',
  Sms = 'sms',
  WhatsApp = 'whatsapp',
}

/**
 * schema.md §12 — the one derived-looking column that IS stored, because it
 * reflects what a provider told us and cannot be computed from anything we hold.
 */
export enum DeliveryStatus {
  Pending = 'pending',
  Sent = 'sent',
  Delivered = 'delivered',
  Failed = 'failed',
}

/** Which secret shape a verification kind uses. Drives generation and comparison. */
export enum VerificationSecretShape {
  /** Six digits. Short window plus attempt limiting is what makes it safe. */
  NumericCode = 'numeric_code',
  /** High-entropy token for a link that has to survive an inbox. */
  Token = 'token',
}
