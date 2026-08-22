import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';

/**
 * Hands a verification secret to its delivery channel.
 *
 * A placeholder for the real email/SMS providers, which are not chosen yet. It
 * exists as a seam so nothing else has to know how delivery happens, and so the
 * flow is complete and testable today.
 *
 * When a provider is chosen, this becomes an `outbound_events` insert inside the
 * issuing transaction (the transactional outbox from schema.md §23 requirement
 * 9) with the relay making the call after commit — NOT a direct provider call
 * from here, which would put network I/O inside a transaction.
 */
@Injectable()
export class VerificationDeliveryService {
  constructor(
    private readonly config: AppConfigService,
    @InjectPinoLogger(VerificationDeliveryService.name) private readonly logger: PinoLogger,
  ) {
  }

  async deliver(verificationRefId: string, secret: string): Promise<void> {
    if (this.config.app.env === 'dev') {
      // Dev only, and gated on the environment rather than the log level: the
      // code has to be readable to test the flow without a provider. It must
      // never be reachable in qa or prod.
      this.logger.warn(
        { verificationRefId, secret },
        'DEV ONLY — verification secret logged because no delivery provider is configured',
      );
      return;
    }

    // Deliberately loud: silently dropping a verification would present to a
    // user as a code that never arrives, which is the hardest kind of bug to
    // diagnose from a support ticket.
    this.logger.error(
      { verificationRefId },
      'no delivery provider is configured — the verification was created but NOT sent',
    );
    return Promise.resolve();
  }
}
