import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { InboundEventType } from '@/shared/enums';
import { scheduleRetry } from '@/modules/ledger/backoff.util';
import { BasePoller } from './base-poller';

/**
 * Projects ledger rows into the domain.
 *
 * The projector is selected on event_type, which is why that column exists.
 * Handlers for the V1 domain features are not built yet, so an event whose
 * projection has no handler is marked SKIPPED with a reason rather than being
 * retried forever or, worse, having domain rows invented for it. Skipped is a
 * terminal, visible state: the row is kept and can be replayed once the handler
 * exists.
 */
type Projector = (payload: unknown, eventId: number) => Promise<void>;

@Injectable()
export class InboundProjectorWorker extends BasePoller {
  protected readonly name = 'inbound-projector';

  private readonly projectors = new Map<InboundEventType, Projector>();

  constructor(
    private readonly inbound: InboundEventRepository,
    protected readonly config: AppConfigService,
    @InjectPinoLogger(InboundProjectorWorker.name) protected readonly logger: PinoLogger,
  ) {
    super();
    // Handlers register here as the domain features land. Registration is
    // explicit so an unhandled type is obvious rather than silently defaulted.
  }

  protected async pollOnce(): Promise<number> {
    const { batchSize, leaseSeconds } = this.config.worker;
    const claimed = await this.inbound.claimBatch(this.leaseOwner, batchSize, leaseSeconds);

    for (const event of claimed) {
      const projector = this.projectors.get(event.eventType);

      if (!projector) {
        await this.inbound.markSkipped(
          event.id,
          `no projector registered for event_type "${event.eventType}"`,
        );
        continue;
      }

      try {
        await projector(event.payload, event.id);
        await this.inbound.markProcessed(event.id);
      } catch (error) {
        // Per-row failure: the batch continues. Retry with jittered backoff, or
        // dead-letter when the budget is spent.
        const message = error instanceof Error ? error.message : 'projection failed';
        const retry = scheduleRetry(event.attemptCount, 3);
        await this.inbound.markFailed(
          event.id,
          message,
          retry?.nextAttemptAt ?? new Date(),
        );
        this.logger.warn(
          { eventId: event.id, eventType: event.eventType, attempt: event.attemptCount },
          'projection failed',
        );
      }
    }

    return claimed.length;
  }
}
