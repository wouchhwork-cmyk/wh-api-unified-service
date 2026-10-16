import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { SyncJobKind, SyncTriggerKind } from '@/shared/enums';

/**
 * Keeps connected accounts from freezing the moment their first backfill ends.
 *
 * Before this, sync_jobs were enqueued once at connect and never again: a Page
 * renamed afterwards kept its old name forever, follower counts stayed at zero,
 * and comment counts never moved. The job kinds existed with nothing to create
 * them.
 *
 * Enqueue only — the backfill worker does the work. That keeps the schedule and
 * the doing separate, so a slow platform delays a refresh rather than blocking
 * the timer, and a missed tick is a late refresh rather than a lost one.
 */
@Injectable()
export class RefreshSchedulerWorker {
  /**
   * A ceiling per tick, so the first run after a busy signup week enqueues a
   * bounded amount of work instead of one job per channel in existence. Channels
   * are ordered by least-recently-synced, so the ones most out of date go first
   * and the rest arrive on the next tick.
   */
  private static readonly CHANNELS_PER_TICK = 200;

  constructor(
    private readonly channels: ChannelRepository,
    private readonly syncJobs: SyncJobRepository,
    @InjectPinoLogger(RefreshSchedulerWorker.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Profiles daily. A name or follower count changing within the day is not
   * worth a platform call per channel per hour.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async scheduleProfileRefresh(): Promise<void> {
    await this.enqueue(SyncJobKind.RefreshProfile);
  }

  /**
   * Post metrics daily too. The refresh key is scoped to the day, so a second
   * run inside one day is a no-op rather than a duplicate.
   */
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async schedulePostMetricsRefresh(): Promise<void> {
    await this.enqueue(SyncJobKind.RefreshPostMetrics);
  }

  private async enqueue(jobKind: SyncJobKind): Promise<void> {
    try {
      const channels = await this.channels.listAllForRefresh(
        RefreshSchedulerWorker.CHANNELS_PER_TICK,
      );

      let enqueued = 0;
      for (const channel of channels) {
        /*
         * enqueueIfAbsent is a no-op while one of these is still live for the
         * channel, so a refresh that is running or waiting is never stacked.
         */
        const created = await this.syncJobs.enqueueIfAbsent({
          enterpriseId: channel.enterpriseId,
          channelId: channel.id,
          jobKind,
          triggerKind: SyncTriggerKind.Scheduled,
        });
        if (created) enqueued += 1;
      }

      // Both numbers, because "considered 200, enqueued 0" and "considered 0"
      // are different problems and would otherwise look identical.
      this.logger.info(
        { jobKind, considered: channels.length, enqueued },
        'scheduled a refresh sweep',
      );
    } catch (error) {
      // A scheduler that throws stops scheduling. Log and let the next tick try.
      this.logger.error({ err: error, jobKind }, 'refresh scheduling failed');
    }
  }
}
