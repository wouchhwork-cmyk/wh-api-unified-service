/** schema.md §15 */
export enum SyncJobKind {
  BackfillPosts = 'backfill_posts',
  BackfillComments = 'backfill_comments',
  BackfillConversations = 'backfill_conversations',
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
