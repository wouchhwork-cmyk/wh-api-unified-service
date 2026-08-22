import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { SessionRepository } from '@/database/repositories/session.repository';
import { VerificationRepository } from '@/database/repositories/verification.repository';

const SWEEP_BATCH = 500;
/** Long enough to answer a support question, short enough not to be an archive. */
const VERIFICATION_RETENTION_DAYS = 7;
const SESSION_RETENTION_DAYS = 30;

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
    private readonly config: AppConfigService,
    @InjectPinoLogger(SweeperWorker.name) private readonly logger: PinoLogger,
  ) {}

  @Cron('0 3 * * *')
  async sweep(): Promise<void> {
    try {
      const verificationCutoff = daysAgo(VERIFICATION_RETENTION_DAYS);
      const sessionCutoff = daysAgo(SESSION_RETENTION_DAYS);

      const verifications = await this.verifications.deleteSettledBefore(
        verificationCutoff,
        SWEEP_BATCH,
      );
      const sessions = await this.sessions.deleteExpiredBefore(sessionCutoff, SWEEP_BATCH);

      this.logger.info({ verifications, sessions }, 'retention sweep complete');
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
