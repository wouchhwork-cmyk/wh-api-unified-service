import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { SendReconciliationService } from '@/modules/inbox/send-reconciliation.service';
import { SEND_RECONCILE_CRON } from '@/shared/constants';

/**
 * The schedule for reading back ambiguous sends, and nothing else.
 *
 * Timer and doing are separate for the same reason as the webhook reconciler:
 * what an ambiguous send means, and what evidence settles it, belongs to
 * `SendReconciliationService`. This class says WHEN, and makes sure one bad run
 * does not stop the next.
 *
 * Not a BasePoller: the rows are claimed inside one statement with
 * `FOR UPDATE SKIP LOCKED` rather than leased across a send, because a
 * read-back holds nothing and repeating one is harmless.
 */
@Injectable()
export class SendReconcilerWorker {
  constructor(
    private readonly reconciliation: SendReconciliationService,
    @InjectPinoLogger(SendReconcilerWorker.name)
    private readonly logger: PinoLogger,
  ) {}

  @Cron(SEND_RECONCILE_CRON)
  async reconcile(): Promise<void> {
    try {
      await this.reconciliation.reconcileAll();
    } catch (error) {
      /*
       * Swallowed on purpose: an unhandled rejection in a cron would take the
       * worker process down, and the next run is ten minutes away. The sends
       * stay unresolved and are picked up then.
       */
      this.logger.error({ err: error }, 'the ambiguous-send sweep failed');
    }
  }
}
