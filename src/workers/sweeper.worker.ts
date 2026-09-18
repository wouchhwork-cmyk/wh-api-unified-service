import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { OauthStateRepository } from '@/database/repositories/oauth-state.repository';
import { SessionRepository } from '@/database/repositories/session.repository';
import { VerificationRepository } from '@/database/repositories/verification.repository';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';

const SWEEP_BATCH = 500;
/** Caps one nightly run at 100k rows per table, so it cannot run unbounded. */
const MAX_SWEEP_PASSES = 200;
/** Long enough to answer a support question, short enough not to be an archive. */
const VERIFICATION_RETENTION_DAYS = 7;
const SESSION_RETENTION_DAYS = 30;
/**
 * How long a SETTLED ledger row is kept.
 *
 * SET AGAINST REDELIVERY, NOT AGAINST DISK. `inbound_events_dedup_uniq` is what
 * makes a webhook Meta sends twice collide instead of being handled twice, and
 * that protection lives in the row — delete it and a redelivery arriving later
 * is indistinguishable from a new event, so a customer's message is duplicated
 * into the thread. Meta retries a failed delivery for hours, and a subscription
 * that is disabled and re-enabled can replay further back than that.
 *
 * Thirty days is far past any of it, and it is the floor rather than a
 * preference: shortening this trades a duplicate message in somebody's inbox
 * for disk, which is not a trade worth making. The ledgers were previously kept
 * FOREVER, so this is the first bound they have had at all.
 */
const LEDGER_RETENTION_DAYS = 30;
/**
 * Short, because an OAuth state is worthless the moment it is spent or expires
 * and nothing ever reads one again. Kept for a day only so a support question
 * about a failed connection can still be answered.
 */
const OAUTH_STATE_RETENTION_DAYS = 1;

/**
 * Periodic housekeeping.
 *
 * Retention here is a privacy commitment as much as a storage one: verification
 * rows record which address was challenged and when, and sessions record device
 * and IP. Neither should be kept indefinitely.
 */
@Injectable()
export class SweeperWorker {
  constructor(
    private readonly verifications: VerificationRepository,
    private readonly sessions: SessionRepository,
    private readonly oauthStates: OauthStateRepository,
    private readonly inboundEvents: InboundEventRepository,
    private readonly outboundEvents: OutboundEventRepository,
    private readonly syncJobs: SyncJobRepository,
    private readonly config: AppConfigService,
    @InjectPinoLogger(SweeperWorker.name) private readonly logger: PinoLogger,
  ) {}

  @Cron('0 3 * * *')
  async sweep(): Promise<void> {
    try {
      const verificationCutoff = daysAgo(VERIFICATION_RETENTION_DAYS);
      const sessionCutoff = daysAgo(SESSION_RETENTION_DAYS);

      // Drains in batches rather than stopping after one. A single capped batch
      // per day cannot keep up with a service issuing more rows than that, so
      // the tables would grow for ever while the sweep looked like it ran.
      const verifications = await drain((limit) =>
        this.verifications.deleteSettledBefore(verificationCutoff, limit),
      );
      const sessions = await drain((limit) =>
        this.sessions.deleteExpiredBefore(sessionCutoff, limit),
      );
      // Otherwise this table only ever grows: a row per connection attempt,
      // never read again once spent.
      const oauthStates = await drain((limit) =>
        this.oauthStates.deleteSettledBefore(daysAgo(OAUTH_STATE_RETENTION_DAYS), limit),
      );

      /*
       * The three ledgers, which until now had no retention at all and grew
       * forever — the largest tables in the schema, and the only ones with a
       * guaranteed daily floor under their growth: the post-metrics refresh
       * enqueues a job per channel every day whether anything changed or not.
       *
       * Swept last, and each drains independently, so a large ledger backlog
       * cannot starve the small tables above it of their sweep.
       */
      const ledgerCutoff = daysAgo(LEDGER_RETENTION_DAYS);
      const inboundEvents = await drain((limit) =>
        this.inboundEvents.deleteSettledBefore(ledgerCutoff, limit),
      );
      const outboundEvents = await drain((limit) =>
        this.outboundEvents.deleteSettledBefore(ledgerCutoff, limit),
      );
      const syncJobs = await drain((limit) =>
        this.syncJobs.deleteSettledBefore(ledgerCutoff, limit),
      );

      this.logger.info(
        { verifications, sessions, oauthStates, inboundEvents, outboundEvents, syncJobs },
        'retention sweep complete',
      );
    } catch (error) {
      this.logger.error({ err: error }, 'retention sweep failed');
    }
  }

  /**
   * Moves provider tokens through expiring_soon and expired, so the UI can warn
   * a business BEFORE its inbox goes quiet rather than after.
   *
   * Deliberately does not notify yet: reauth_notified_at exists so the notifier
   * does not re-email on every run, and wiring that without a delivery provider
   * would mean writing state for a message nobody sends.
   */
  @Cron('0 * * * *')
  async flagExpiringTokens(): Promise<void> {
    this.logger.debug(
      { warningWindowDays: this.config.worker.expiryWarningWindowDays },
      'token expiry sweep tick',
    );
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Repeats a batched delete until it stops finding rows, bounded by a pass count
 * so a bug cannot turn the sweep into an endless loop holding the connection.
 */
async function drain(deleteBatch: (limit: number) => Promise<number>): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < MAX_SWEEP_PASSES; pass += 1) {
    const deleted = await deleteBatch(SWEEP_BATCH);
    total += deleted;
    if (deleted < SWEEP_BATCH) break;
  }
  return total;
}
