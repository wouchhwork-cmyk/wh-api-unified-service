import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';

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
    @InjectPinoLogger(LeaseReaperWorker.name) private readonly logger: PinoLogger,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async reclaim(): Promise<void> {
    try {
      const [inboundCount, outboundCount] = await Promise.all([
        this.inbound.reclaimExpiredLeases(LeaseReaperWorker.BATCH),
        this.outbound.reclaimExpiredLeases(LeaseReaperWorker.BATCH),
      ]);

      if (inboundCount > 0 || outboundCount > 0) {
        // Worth a log line: a steady stream here means workers are dying, which
        // no other signal makes obvious.
        this.logger.warn({ inboundCount, outboundCount }, 'reclaimed expired leases');
      }
    } catch (error) {
      this.logger.error({ err: error }, 'lease reclaim failed');
    }
  }
}
