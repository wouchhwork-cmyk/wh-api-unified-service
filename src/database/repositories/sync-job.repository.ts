import { Injectable } from '@nestjs/common';
import {
  CLAIMABLE_SYNC_JOB_STATUSES,
  SyncJobKind,
  SyncJobStatus,
  SyncTriggerKind,
} from '@/shared/enums';
import { BaseRepository } from './base.repository';
import { NOTIFY_SYNC_CHANNEL } from '@/shared/constants';

@Injectable()
export class SyncJobRepository extends BaseRepository {
  /**
   * Enqueues the initial backfill for a channel.
   *
   * ON CONFLICT DO NOTHING against sync_jobs_live_uniq: at most one live job of
   * a kind per channel. Reconnecting an already-syncing account must not start a
   * second walk of the same history.
   *
   * The conflict target repeats the index predicate because the index is
   * partial — Postgres cannot infer a partial index from the column list alone.
   */
  async enqueueIfAbsent(input: {
    enterpriseId: number;
    channelId: number;
    jobKind: SyncJobKind;
    triggerKind: SyncTriggerKind;
  }): Promise<boolean> {
    const { affected } = await this.mutate(
      `INSERT INTO sync_jobs (enterprise_id, channel_id, job_kind, trigger_kind, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (channel_id, job_kind)
         WHERE is_deleted = false AND status IN ('pending','running','paused','rate_limited')
       /*
        * A PAUSED row is REVIVED here, and this is the only way out of paused.
        *
        * It used to be DO NOTHING, which made paused a one-way door: the row is
        * unclaimable but still occupies the live slot in sync_jobs_live_uniq, so
        * nothing could ever be enqueued for that channel and kind again. A
        * channel paused for a missing permission stayed dead after the
        * permission was granted, and the only visible symptom was a backfill
        * that never ran.
        *
        * Reviving on re-request is the right trigger rather than a timer: the
        * callers are a reconnect and the daily refresh sweep — the two moments
        * when the reason for the pause may genuinely have changed. If it has
        * not, the worker pauses it again, which costs one claim a day.
        */
       DO UPDATE SET
         status          = $5,
         trigger_kind    = EXCLUDED.trigger_kind,
         next_attempt_at = now(),
         attempt_count   = 0,
         last_error      = NULL,
         updated_at      = now()
         WHERE sync_jobs.status = 'paused'
       RETURNING id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.channelId,
        input.jobKind,
        input.triggerKind,
        SyncJobStatus.Pending,
      ],
    );
    if (affected > 0) await this.notifyQueue(NOTIFY_SYNC_CHANNEL);
    return affected > 0;
  }

  async listForChannel(
    enterpriseId: number,
    channelId: number,
  ): Promise<
    { refId: string; jobKind: SyncJobKind; status: SyncJobStatus; syncedItemCount: number }[]
  > {
    return this.query(
      `SELECT ref_id AS "refId", job_kind AS "jobKind", status,
              synced_item_count AS "syncedItemCount"
         FROM sync_jobs
        WHERE enterprise_id = $1 AND channel_id = $2 AND is_deleted = false
        ORDER BY created_at DESC
        LIMIT 50`,
      [this.requireEnterprise(enterpriseId), channelId],
    );
  }

  /**
   * Claims runnable sync jobs, exactly as the ledger workers claim events.
   *
   * ORDER BY repeats the runnable index expression verbatim
   * (COALESCE(next_attempt_at, rate_limited_until, created_at), id) so the claim
   * is an index scan rather than a sort over the table, and the id tiebreaker
   * keeps it deterministic when many jobs come due in the same millisecond.
   *
   * NOT tenant-scoped, like every other worker claim: the enterprise is a column
   * on the row and is carried into everything the job then does.
   */
  async claimBatch(
    leaseOwner: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<
    {
      id: number;
      enterpriseId: number;
      channelId: number;
      jobKind: SyncJobKind;
      pageCursor: string | null;
      attemptCount: number;
      syncedItemCount: number;
    }[]
  > {
    const { rows } = await this.mutate<{
      id: number;
      enterprise_id: number;
      channel_id: number;
      job_kind: SyncJobKind;
      page_cursor: string | null;
      attempt_count: number;
      synced_item_count: number;
    }>(
      `UPDATE sync_jobs
          SET status = $1,
              lease_owner = $2,
              lease_expires_at = now() + ($3::int * interval '1 second'),
              attempt_count = attempt_count + 1,
              started_at = COALESCE(started_at, now()),
              updated_at = now()
        WHERE id IN (
          SELECT id FROM sync_jobs
           WHERE is_deleted = false
             AND status = ANY($4)
             AND COALESCE(next_attempt_at, rate_limited_until, created_at) <= now()
           ORDER BY COALESCE(next_attempt_at, rate_limited_until, created_at), id
           LIMIT $5
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, enterprise_id, channel_id, job_kind, page_cursor,
                  attempt_count, synced_item_count`,
      [SyncJobStatus.Running, leaseOwner, leaseSeconds, [...CLAIMABLE_SYNC_JOB_STATUSES], limit],
    );

    return rows.map((row) => ({
      id: row.id,
      enterpriseId: row.enterprise_id,
      channelId: row.channel_id,
      jobKind: row.job_kind,
      pageCursor: row.page_cursor,
      attemptCount: row.attempt_count,
      syncedItemCount: row.synced_item_count,
    }));
  }

  /**
   * Saves a slice: the cursor to resume from and the items it added.
   *
   * FENCED on lease_owner. A run that overran its lease has already been
   * reclaimed and possibly re-claimed elsewhere; writing its cursor then would
   * rewind the worker that now owns the job. Returns false so the caller stops.
   */
  async saveProgress(
    id: number,
    leaseOwner: string,
    pageCursor: string | null,
    itemsAdded: number,
    leaseSeconds: number,
  ): Promise<boolean> {
    const { affected } = await this.mutate(
      /*
       * attempt_count is RESET here, because it counts consecutive failures and
       * a saved page is not a failure. Every claim increments it, and a long
       * backfill is deliberately claimed many times — one slice per run — so
       * without this reset a Page with more than SYNC_MAX_ATTEMPTS pages of
       * history dead-lettered itself partway through a walk that was succeeding.
       */
      `UPDATE sync_jobs
          SET page_cursor = $3,
              synced_item_count = synced_item_count + $4,
              attempt_count = 0,
              lease_expires_at = now() + ($5::int * interval '1 second'),
              updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = $6`,
      [id, leaseOwner, pageCursor, itemsAdded, leaseSeconds, SyncJobStatus.Running],
    );
    return affected > 0;
  }

  /** The walk reached the end of the edge. Terminal and successful. */
  async markCompleted(id: number, leaseOwner: string, itemsAdded: number): Promise<void> {
    await this.mutate(
      `UPDATE sync_jobs
          SET status = $3, synced_item_count = synced_item_count + $4,
              completed_at = now(), lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND lease_owner = $2`,
      [id, leaseOwner, SyncJobStatus.Completed, itemsAdded],
    );
  }

  /**
   * Retryable failure, or dead-letter when the budget is spent.
   *
   * nextAttemptAt null means "no attempts left": the row becomes terminal rather
   * than being retried forever.
   */
  async markFailed(
    id: number,
    leaseOwner: string,
    error: string,
    nextAttemptAt: Date | null,
  ): Promise<void> {
    await this.mutate(
      `UPDATE sync_jobs
          SET status = $3,
              last_error = left($4, 1000),
              last_error_at = now(),
              next_attempt_at = $5,
              dead_lettered_at = CASE WHEN $5::timestamptz IS NULL THEN now() ELSE NULL END,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND lease_owner = $2`,
      [
        id,
        leaseOwner,
        nextAttemptAt === null ? SyncJobStatus.DeadLetter : SyncJobStatus.Failed,
        error,
        nextAttemptAt,
      ],
    );
  }

  /**
   * Meta said "too fast". Parking the job is the correct response — retrying on
   * the normal backoff would spend the same quota again and deepen the limit.
   */
  async markRateLimited(id: number, leaseOwner: string, until: Date, error: string): Promise<void> {
    await this.mutate(
      `UPDATE sync_jobs
          SET status = $3, rate_limited_until = $4, next_attempt_at = NULL,
              last_error = left($5, 1000), last_error_at = now(),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND lease_owner = $2`,
      [id, leaseOwner, SyncJobStatus.RateLimited, until, error],
    );
  }

  /**
   * Stopped for a reason no retry can fix — an unimplemented platform, or a
   * channel whose token needs re-auth. Paused is NOT claimable, so it waits for
   * a human or a reconnect instead of burning attempts.
   */
  async markPaused(id: number, leaseOwner: string, reason: string): Promise<void> {
    await this.mutate(
      `UPDATE sync_jobs
          SET status = $3, last_error = left($4, 1000), last_error_at = now(),
              next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
              updated_at = now()
        WHERE id = $1 AND lease_owner = $2`,
      [id, leaseOwner, SyncJobStatus.Paused, reason],
    );
  }

  /**
   * Returns jobs whose lease lapsed to the runnable pool.
   *
   * Without this a worker killed mid-walk leaves its job 'running' forever, and
   * 'running' is not claimable — the backfill would simply never resume. This is
   * the gap the inbound and outbound ledgers already had covered.
   */
  async reclaimExpiredLeases(limit: number): Promise<number> {
    const { affected } = await this.mutate(
      `UPDATE sync_jobs
          SET status = $1, lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = now(), updated_at = now()
        WHERE id IN (
          SELECT id FROM sync_jobs
           WHERE status = $2 AND lease_expires_at IS NOT NULL AND lease_expires_at < now()
           ORDER BY lease_expires_at
           LIMIT $3
           FOR UPDATE SKIP LOCKED
        )`,
      [SyncJobStatus.Pending, SyncJobStatus.Running, limit],
    );
    return affected;
  }
}
