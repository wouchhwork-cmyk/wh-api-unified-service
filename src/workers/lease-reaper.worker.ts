import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { ModelCallRepository } from '@/database/repositories/model-call.repository';
import { MODEL_CALL_ABANDONED_MS } from '@/shared/constants';

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
    private readonly modelCalls: ModelCallRepository,
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
      /*
       * model_calls is NOT a lease, and belongs here anyway.
       *
       * There is no work to hand back — the row is a note about a call that
       * already went out. What it has in common with the three above is the
       * cause: a process that died holding something. Left alone, the row
       * claims to be in flight for ever; settled, it says the honest thing,
       * which is that the call was made and nobody learned the outcome.
       */
      const [inboundCount, outboundCount, syncCount, unknownCalls] = await Promise.all([
        this.inbound.reclaimExpiredLeases(LeaseReaperWorker.BATCH),
        this.outbound.reclaimExpiredLeases(LeaseReaperWorker.BATCH),
        this.syncJobs.reclaimExpiredLeases(LeaseReaperWorker.BATCH),
        this.modelCalls.settleAbandoned(MODEL_CALL_ABANDONED_MS),
      ]);

      if (inboundCount > 0 || outboundCount > 0 || syncCount > 0) {
        // Worth a log line: a steady stream here means workers are dying, which
        // no other signal makes obvious.
        this.logger.warn({ inboundCount, outboundCount, syncCount }, 'reclaimed expired leases');
      }

      if (unknownCalls > 0) {
        /*
         * Its own line, and a louder one than it looks. Every row here is a
         * model call that may have been billed and whose answer nobody has.
         */
        this.logger.warn(
          { unknownCalls },
          'model calls went out and their outcome was never recorded',
        );
      }
    } catch (error) {
      this.logger.error({ err: error }, 'lease reclaim failed');
    }
  }
}
