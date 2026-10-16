import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { OtpSenderService, OtpSendMode } from '@/modules/communication';
import type { PendingOtpDelivery } from './verification.service';

/**
 * Gets an issued verification to the person it was issued for.
 *
 * A thin adapter over the communication module, kept as its own class because
 * the auth flows should depend on "deliver this verification" and not on which
 * transport is behind it. When the real provider lands, only the communication
 * module changes.
 *
 * Delivery is attempted AFTER the issuing transaction commits, deliberately: a
 * vendor HTTP call inside a transaction would hold a database connection open
 * for the length of a network round trip.
 */
@Injectable()
export class VerificationDeliveryService {
  constructor(
    private readonly otp: OtpSenderService,
    @InjectPinoLogger(VerificationDeliveryService.name) private readonly logger: PinoLogger,
  ) {}

  async deliver(delivery: PendingOtpDelivery): Promise<void> {
    const result = await this.otp.send({
      channel: delivery.channel,
      destination: delivery.destination,
      otpCode: delivery.otpCode,
      purpose: delivery.purpose,
      expiresInSeconds: delivery.expiresInSeconds,
    });

    if (result.mode === OtpSendMode.Failed) {
      // Loud, because a verification that exists but never arrives presents to
      // the user as a code that simply never comes — the hardest thing to
      // diagnose from a support ticket. The refId ties this line to the row.
      this.logger.error(
        { verificationRefId: delivery.verificationRefId, purpose: delivery.purpose },
        'verification was created but delivery failed — the user must resend',
      );
      return;
    }

    this.logger.info(
      {
        verificationRefId: delivery.verificationRefId,
        purpose: delivery.purpose,
        mode: result.mode,
        provider: result.provider,
      },
      'verification delivery attempted',
    );
  }
}
