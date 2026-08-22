import { Injectable } from '@nestjs/common';
import { SyncJobKind, SyncJobStatus, SyncTriggerKind } from '@/shared/enums';
import { BaseRepository } from './base.repository';

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
       DO NOTHING
       RETURNING id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.channelId,
        input.jobKind,
        input.triggerKind,
        SyncJobStatus.Pending,
      ],
    );
    return affected > 0;
  }

  async listForChannel(
    enterpriseId: number,
    channelId: number,
  ): Promise<{ refId: string; jobKind: SyncJobKind; status: SyncJobStatus; syncedItemCount: number }[]> {
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
}
