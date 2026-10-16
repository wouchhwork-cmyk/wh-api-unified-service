/** schema.md §15 */
export enum SyncJobKind {
  BackfillPosts = 'backfill_posts',
  BackfillComments = 'backfill_comments',
  BackfillConversations = 'backfill_conversations',
  /**
   * Instagram's `tags` edge — posts by other people that tagged this account.
   *
   * The only source of mention HISTORY. Meta's `mentions` webhook carries a
   * media or comment id and no author, so a live mention cannot be projected at
   * all; without this walk a business's mention feed starts empty and stays
   * that way for anything older than the connection.
   */
  BackfillMentions = 'backfill_mentions',
  /**
   * One customer's message thread, re-read from the platform.
   *
   * Repair, not history. A webhook that never arrived — Meta drops one often
   * enough to matter — leaves a hole nothing else fills, and the Conversations
   * API can be asked for exactly one participant's thread with `user_id`. It is
   * deliberately NOT BackfillConversations: that walks every conversation on the
   * channel, holds the channel's one live slot, and is meant to run once at
   * connect.
   *
   * Meta returns only the 20 most recent messages of a thread, so this recovers
   * a recent gap and cannot reach back further than that.
   */
  ResyncConversation = 'resync_conversation',
  RefreshProfile = 'refresh_profile',
  RefreshPostMetrics = 'refresh_post_metrics',
}

export enum SyncTriggerKind {
  InitialConnect = 'initial_connect',
  Scheduled = 'scheduled',
  Manual = 'manual',
  Reconnect = 'reconnect',
}

export enum SyncJobStatus {
  Pending = 'pending',
  Running = 'running',
  Paused = 'paused',
  RateLimited = 'rate_limited',
  Completed = 'completed',
  Failed = 'failed',
  DeadLetter = 'dead_letter',
  Cancelled = 'cancelled',
}

/** The statuses the runnable index covers — a worker can claim exactly these. */
export const CLAIMABLE_SYNC_JOB_STATUSES: readonly SyncJobStatus[] = [
  SyncJobStatus.Pending,
  SyncJobStatus.Failed,
  SyncJobStatus.RateLimited,
] as const;

/** Statuses that occupy the one-live-job-per-kind-per-channel slot. */
export const LIVE_SYNC_JOB_STATUSES: readonly SyncJobStatus[] = [
  SyncJobStatus.Pending,
  SyncJobStatus.Running,
  SyncJobStatus.Paused,
  SyncJobStatus.RateLimited,
] as const;
