import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { maskEmail, maskMobile } from '@/shared/utils/normalize';
import { DeliveryChannel } from '@/shared/enums';
import type { OtpDispatch, OtpProvider, SendOtpCommand } from './otp-provider';

/**
 * Stands in for the real vendor until one is chosen.
 *
 * It reports `accepted: true` because the flow it feeds — signup, login — must
 * be walkable end to end today. It is only ever reachable with
 * OTP_REALTIME_ENABLED=true, which prod requires and dev leaves off, so the
 * combination that would matter (a mock accepting real production traffic)
 * cannot arise without someone deliberately turning realtime on in dev.
 */
@Injectable()
export class MockOtpProvider implements OtpProvider {
  readonly name = 'mock';

  constructor(@InjectPinoLogger(MockOtpProvider.name) private readonly logger: PinoLogger) {}

  send(command: SendOtpCommand): Promise<OtpDispatch> {
    // The destination is masked and the code is absent: this line exists to
    // prove the provider was reached, not to reveal what was sent.
    this.logger.info(
      {
        provider: this.name,
        channel: command.channel,
        purpose: command.purpose,
        destination: mask(command.channel, command.destination),
      },
      'mock OTP provider accepted a message — nothing was actually sent',
    );

    return Promise.resolve({ providerMessageId: null, accepted: true });
  }
}

function mask(channel: DeliveryChannel, destination: string): string {
  return channel === DeliveryChannel.Email ? maskEmail(destination) : maskMobile(destination);
}
