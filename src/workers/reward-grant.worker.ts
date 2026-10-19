import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { RewardGrantService } from '@/modules/rewards/reward-grant.service';
import { REWARD_GRANT_CRON } from '@/shared/constants';

/**
 * The schedule for granting held reward awards, and nothing else.
 *
 * Timer and doing are separate, as with the other reconcilers: what a lapsed
 * hold means belongs to RewardGrantService. This says WHEN, and makes sure one
 * bad run does not stop the next.
 *
 * Not a BasePoller. Nothing is leased across the grant — the work is a single
 * transaction per award, and the ledger's idempotency key is derived from the
 * award and the benefit index, so a repeated attempt writes nothing twice.
 */
@Injectable()
export class RewardGrantWorker {
  constructor(
    private readonly grants: RewardGrantService,
    @InjectPinoLogger(RewardGrantWorker.name)
    private readonly logger: PinoLogger,
  ) {}

  @Cron(REWARD_GRANT_CRON)
  async grant(): Promise<void> {
    try {
      const granted = await this.grants.grantDueAwards();
      if (granted > 0) {
        this.logger.info({ granted }, 'reward awards granted after hold');
      }
    } catch (error) {
      this.logger.error(
        { err: error },
        'reward grant sweep failed; the next tick will retry the same awards',
      );
    }
  }
}
