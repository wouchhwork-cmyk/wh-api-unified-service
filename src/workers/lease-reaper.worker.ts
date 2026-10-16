import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';

/**
 * Returns rows whose worker died mid-lease.
 *
 * This is what makes a lease safe to hold: leases are ALWAYS bounded, and an
 * unbounded lock would be an outage. A worker that is killed loses its claim,
 * not the work.
 */
@Injectable()
export class LeaseReaperWorker {
  private static readonly BATCH = 200;

  constructor(
    private readonly inbound: InboundEventRepository,
    private readonly outbound: OutboundEventRepository,
    private readonly syncJobs: SyncJobRepository,
    @InjectPinoLogger(LeaseReaperWorker.name) private readonly logger: PinoLogger,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async reclaim(): Promise<void> {
    try {
      /*
       * sync_jobs belongs here for a sharper reason than the ledgers: 'running'
       * is not a claimable status, so a backfill whose worker died does not
       * retry late — it never resumes at all.
       */
      const [inboundCount, outboundCount, syncCount] = await Promise.all([
        this.inbound.reclaimExpiredLeases(LeaseReaperWorker.BATCH),
        this.outbound.reclaimExpiredLeases(LeaseReaperWorker.BATCH),
        this.syncJobs.reclaimExpiredLeases(LeaseReaperWorker.BATCH),
      ]);

      if (inboundCount > 0 || outboundCount > 0 || syncCount > 0) {
        // Worth a log line: a steady stream here means workers are dying, which
        // no other signal makes obvious.
        this.logger.warn({ inboundCount, outboundCount, syncCount }, 'reclaimed expired leases');
      }
    } catch (error) {
      this.logger.error({ err: error }, 'lease reclaim failed');
    }
  }
}
