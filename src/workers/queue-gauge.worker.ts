import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  QueueMetricsRepository,
  type QueueGauge,
} from '@/database/repositories/queue-metrics.repository';

/**
 * Samples the queues and emits them as one structured line per minute.
 *
 * There is no metrics backend in V1, and adding one is infrastructure this
 * deployment does not have. A structured log line is the cheapest thing that
 * still answers the question later: every field is a number with a stable name,
 * so whatever eventually scrapes logs can chart these without the code changing.
 *
 * The line is emitted at WARN when something is actually wrong and INFO
 * otherwise, so "is anything behind?" is a level filter rather than a query.
 */
@Injectable()
export class QueueGaugeWorker {
  /**
   * How far behind is too far. A due row older than this means workers are not
   * keeping up — for an inbox this is user-visible, so the bar is low.
   */
  private static readonly LAG_WARN_SECONDS = 60;

  constructor(
    private readonly queueMetrics: QueueMetricsRepository,
    @InjectPinoLogger(QueueGaugeWorker.name) private readonly logger: PinoLogger,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sample(): Promise<void> {
    let gauges: QueueGauge[];
    try {
      gauges = await this.queueMetrics.gauges();
    } catch (error) {
      // Never let the gauge take the process down: it is an observer.
      this.logger.error({ err: error }, 'queue gauge sample failed');
      return;
    }

    /*
       RECENT dead letters, not the cumulative total. The total counted every
       dead letter ever recorded, so one poison message pinned this at WARN
       permanently — and an alarm that is always on is worse than none, because
       it trains whoever reads the logs to ignore it. The total is still
       reported below, for context.
     */
    const worrying = gauges.filter(
      (gauge) =>
        gauge.recentDeadLettered > 0 ||
        (gauge.oldestDueAgeSeconds ?? 0) > QueueGaugeWorker.LAG_WARN_SECONDS,
    );

    const payload = Object.fromEntries(
      gauges.map((gauge) => [
        gauge.queue,
        {
          depth: gauge.depth,
          due: gauge.due,
          lagSeconds: gauge.oldestDueAgeSeconds,
          leased: gauge.leased,
          deadLettered: gauge.deadLettered,
          recentDeadLettered: gauge.recentDeadLettered,
        },
      ]),
    );

    if (worrying.length > 0) {
      this.logger.warn(
        { queues: payload, behind: worrying.map((gauge) => gauge.queue) },
        'queue gauge — work is behind or dead-lettered',
      );
      return;
    }

    this.logger.info({ queues: payload }, 'queue gauge');
  }
}
