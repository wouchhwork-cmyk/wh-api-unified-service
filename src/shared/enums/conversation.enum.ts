/** schema.md §20 */
export enum ConversationKind {
  DirectMessage = 'direct_message',
  CommentThread = 'comment_thread',
  Mention = 'mention',
  /*
   * NO StoryReply. A story reply lands in the DM thread with that person —
   * `THREAD_KEY_PREFIX` said so by mapping it to the same 'dm' prefix — so a
   * conversation kind for it was never reachable, and the projector never
   * assigned it. The concept belongs one level down, where it is live:
   * `MessageKind.StoryReply` marks the individual message, which is the thing
   * that really is a story reply. A thread carries both those and ordinary DMs
   * over its life, so naming the whole thread after one message was the wrong
   * shape. Removed rather than left dead (docs/platform-limitations.md §8.2).
   */
  Review = 'review',
}

export enum ConversationStatus {
  Open = 'open',
  Pending = 'pending',
  Resolved = 'resolved',
  Closed = 'closed',
  Archived = 'archived',
}

/** schema.md §21 — one table for both sides, so a thread is one query. */
export enum MessageDirection {
  Inbound = 'inbound',
  Outbound = 'outbound',
}

export enum MessageKind {
  Text = 'text',
  Image = 'image',
  Video = 'video',
  Audio = 'audio',
  Sticker = 'sticker',
  StoryReply = 'story_reply',
  /**
   * A document, a shared link, a location — anything whose attachment is not
   * playable media. Added when attachments started being stored: `share` and
   * `file` had no honest kind and were being recorded as text.
   */
  File = 'file',
}

export enum MessageStatus {
  Pending = 'pending',
  Sending = 'sending',
  Sent = 'sent',
  Delivered = 'delivered',
  Failed = 'failed',
}

/** schema.md §19 */
export enum PostKind {
  Image = 'image',
  Video = 'video',
  Carousel = 'carousel',
  Reel = 'reel',
  Story = 'story',
  Text = 'text',
  Link = 'link',
}

export enum PostStatus {
  Published = 'published',
  PlatformDeleted = 'platform_deleted',
  SyncFailed = 'sync_failed',
}

/**
 * schema.md — thread-key prefixes. platform_thread_id is NOT NULL, and Meta has
 * no thread object for comments, so the key is derived and prefixed by kind so
 * two id spaces can never collide.
 */
export const THREAD_KEY_PREFIX: Readonly<Record<ConversationKind, string>> = {
  [ConversationKind.DirectMessage]: 'dm',
  [ConversationKind.CommentThread]: 'comment',
  [ConversationKind.Mention]: 'mention',
  [ConversationKind.Review]: 'review',
} as const;
