/** schema.md provider/platform split — the OAuth authority we authenticate against. */
export enum Provider {
  Meta = 'meta',
  Google = 'google',
  Zendesk = 'zendesk',
  HubSpot = 'hubspot',
}

export enum ProviderCategory {
  Social = 'social',
  Helpdesk = 'helpdesk',
  Crm = 'crm',
  Email = 'email',
  Messaging = 'messaging',
}

/** The specific surface a channel exists on. One provider yields many platforms. */
export enum Platform {
  Facebook = 'facebook',
  Instagram = 'instagram',
  WhatsApp = 'whatsapp',
  YouTube = 'youtube',
  Zendesk = 'zendesk',
  /** Events we generate ourselves — verification sends, internal notifications. */
  Internal = 'internal',
}

/** What sort of surface it is. */
export enum ChannelKind {
  Page = 'page',
  Profile = 'profile',
  Group = 'group',
  Helpdesk = 'helpdesk',
  Mailbox = 'mailbox',
}

/**
 * schema.md §13–14 — derived state so the API and the UI do not each
 * re-implement the date maths. `not_applicable` covers platforms with no
 * channel-level token (Instagram authorises with the parent Page token).
 */
export enum TokenStatus {
  Valid = 'valid',
  ExpiringSoon = 'expiring_soon',
  Expired = 'expired',
  Revoked = 'revoked',
  NotApplicable = 'not_applicable',
}

/** schema.md §13 */
export enum ConnectionStatus {
  Active = 'active',
  Expired = 'expired',
  Revoked = 'revoked',
}

/** schema.md §14 */
export enum ChannelStatus {
  Active = 'active',
  Disconnected = 'disconnected',
  Expired = 'expired',
  Error = 'error',
}
