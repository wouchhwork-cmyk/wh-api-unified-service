/** schema.md §23 */
export enum InboundEventStatus {
  Pending = 'pending',
  Leased = 'leased',
  Processing = 'processing',
  Processed = 'processed',
  Failed = 'failed',
  DeadLetter = 'dead_letter',
  Skipped = 'skipped',
}

/** schema.md §24 */
export enum OutboundEventStatus {
  Pending = 'pending',
  Scheduled = 'scheduled',
  Leased = 'leased',
  Sending = 'sending',
  Sent = 'sent',
  Failed = 'failed',
  DeadLetter = 'dead_letter',
  Cancelled = 'cancelled',
}

/** Exactly the statuses the claimable partial index covers (schema.md §23). */
export const CLAIMABLE_INBOUND_STATUSES: readonly InboundEventStatus[] = [
  InboundEventStatus.Pending,
  InboundEventStatus.Failed,
] as const;

/** Statuses whose lease can lapse and be reclaimed by the reaper. */
export const LEASED_INBOUND_STATUSES: readonly InboundEventStatus[] = [
  InboundEventStatus.Leased,
  InboundEventStatus.Processing,
] as const;

export const DUE_OUTBOUND_STATUSES: readonly OutboundEventStatus[] = [
  OutboundEventStatus.Pending,
  OutboundEventStatus.Scheduled,
  OutboundEventStatus.Failed,
] as const;

export const LEASED_OUTBOUND_STATUSES: readonly OutboundEventStatus[] = [
  OutboundEventStatus.Leased,
  OutboundEventStatus.Sending,
] as const;

/** schema.md §23 — where an inbound event came from. */
export enum SourceKind {
  Channel = 'channel',
  ProviderConnection = 'provider_connection',
  System = 'system',
  KafkaTopic = 'kafka_topic',
  Queue = 'queue',
}

/** schema.md §24 — where an outbound event is going. */
export enum DestinationKind {
  Channel = 'channel',
  ProviderConnection = 'provider_connection',
  System = 'system',
  KafkaTopic = 'kafka_topic',
  Queue = 'queue',
  Webhook = 'webhook',
}

/** schema.md §23 — selects the projector. */
export enum InboundEventType {
  Comment = 'comment',
  DirectMessage = 'direct_message',
  Mention = 'mention',
  PostUpdate = 'post_update',
  StoryReply = 'story_reply',
  /** Meta told us a permission was removed or the app was deauthorised. */
  PermissionChange = 'permission_change',
}

/** schema.md §24 — selects the sender AND the write-back handler. */
export enum OutboundEventType {
  CommentReply = 'comment_reply',
  /**
   * A reply to a comment that @mentioned us, which is NOT a comment reply.
   *
   * A mention lives on somebody else's post, and `POST /{comment-id}/replies`
   * works only on media we own — it fails there with an error that reads like a
   * deleted comment. Meta's mentions edge is the only way to answer one, so it
   * gets its own type rather than being squeezed through the comment path.
   */
  MentionReply = 'mention_reply',
  DirectMessage = 'direct_message',
  CommentHide = 'comment_hide',
  CommentDelete = 'comment_delete',
  PostPublish = 'post_publish',
  /** Verification code delivery, through the same transactional outbox. */
  VerificationSend = 'verification_send',
}

/**
 * schema.md §23 — NUMERIC, and deliberately so: the claim index orders on this
 * column, and alphabetical VARCHAR ordering would run 'high' before 'urgent'.
 * Smaller runs sooner.
 */
export enum EventPriority {
  Urgent = 10,
  High = 20,
  Normal = 30,
  Low = 40,
}
