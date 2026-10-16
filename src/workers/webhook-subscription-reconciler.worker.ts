import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { WebhookSubscriptionService } from '@/modules/connections/webhook-subscription.service';
import { WEBHOOK_RECONCILE_CRON } from '@/shared/constants';

/**
 * The schedule for webhook-subscription reconciliation, and nothing else.
 *
 * Timer and doing are separate here for the same reason they are in the refresh
 * scheduler: the rules about what a subscription must contain, what to do when
 * it does not, and what a dead token means belong to
 * `WebhookSubscriptionService`, which the API process could also call. This
 * class exists to say WHEN, and to make sure a failure does not stop the next
 * run from happening.
 *
 * Not a BasePoller: there is no queue to claim. That pattern serves the ledger
 * tables, where a row IS a unit of work and two workers must never take the same
 * one. This is a sweep over current state with no rows to lease, which is the
 * shape the cron workers already have (refresh scheduler, sweeper, gauge).
 */
@Injectable()
export class WebhookSubscriptionReconcilerWorker {
  constructor(
    private readonly subscriptions: WebhookSubscriptionService,
    @InjectPinoLogger(WebhookSubscriptionReconcilerWorker.name)
    private readonly logger: PinoLogger,
  ) {}

  @Cron(WEBHOOK_RECONCILE_CRON)
  async reconcile(): Promise<void> {
    try {
      const summary = await this.subscriptions.reconcileAll();

      /*
       * Every count, always — including the zeroes. "considered 40, verified 40"
       * and "considered 0" are different situations and would otherwise look
       * identical, and a run that repaired nothing is the evidence that the
       * subscriptions are still intact. runId ties this line to the per-channel
       * lines the service emitted.
       */
      this.logger.info({ ...summary }, 'webhook subscription reconciliation complete');
    } catch (error) {
      // A scheduler that throws stops scheduling. The service already contains
      // per-channel failures, so reaching here means the population query itself
      // failed; log it and let the next tick try.
      this.logger.error({ err: error }, 'webhook subscription reconciliation failed');
    }
  }
}
