import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { DeliveryChannel } from '@/shared/enums';
import { maskEmail, maskMobile } from '@/shared/utils/normalize';
import { OTP_PROVIDER, type OtpProvider, type SendOtpCommand } from './providers/otp-provider';

/** What actually happened to a code, for the caller's log line and metrics. */
export enum OtpSendMode {
  /** Realtime delivery is off: nothing was sent, and the code is the fixed one. */
  Suppressed = 'suppressed',
  /** A provider accepted it. */
  Sent = 'sent',
  /** A provider was called and refused or failed. */
  Failed = 'failed',
}

export interface OtpSendResult {
  readonly mode: OtpSendMode;
  readonly provider: string | null;
  readonly providerMessageId: string | null;
}

/**
 * The single function every flow calls to get a code to a person.
 *
 * It reads one switch — OTP_REALTIME_ENABLED — and that switch decides whether a
 * vendor is contacted at all. With it off nothing leaves the process, which is
 * what lets the product be developed and demonstrated before an SMS contract
 * exists.
 *
 * A failure here is reported, never thrown. The verification row is already
 * committed by the time delivery is attempted, so throwing would fail a request
 * whose durable work succeeded, and the user would be told their signup broke
 * when in fact only the SMS did. They can resend.
 */
@Injectable()
export class OtpSenderService {
  constructor(
    private readonly config: AppConfigService,
    @Inject(OTP_PROVIDER) private readonly provider: OtpProvider,
    @InjectPinoLogger(OtpSenderService.name) private readonly logger: PinoLogger,
  ) {}

  /** True when issued codes are the fixed constant rather than random. */
  get isRealtimeEnabled(): boolean {
    return this.config.otp.realtimeEnabled;
  }

  async send(command: SendOtpCommand): Promise<OtpSendResult> {
    if (!this.config.otp.realtimeEnabled) {
      this.logger.warn(
        {
          channel: command.channel,
          purpose: command.purpose,
          destination: mask(command.channel, command.destination),
        },
        'realtime OTP is disabled — no message sent; the fixed development code applies',
      );
      return { mode: OtpSendMode.Suppressed, provider: null, providerMessageId: null };
    }

    try {
      const dispatch = await this.provider.send(command);
      if (!dispatch.accepted) {
        this.logger.error(
          { provider: this.provider.name, channel: command.channel, purpose: command.purpose },
          'OTP provider refused the message',
        );
        return { mode: OtpSendMode.Failed, provider: this.provider.name, providerMessageId: null };
      }

      return {
        mode: OtpSendMode.Sent,
        provider: this.provider.name,
        providerMessageId: dispatch.providerMessageId,
      };
    } catch (error) {
      // Loud, and swallowed on purpose: see the class comment. The caller's
      // durable work is already committed and a resend is the user's recourse.
      this.logger.error(
        { err: error, provider: this.provider.name, channel: command.channel },
        'OTP provider threw — the verification exists but was not delivered',
      );
      return { mode: OtpSendMode.Failed, provider: this.provider.name, providerMessageId: null };
    }
  }
}

function mask(channel: DeliveryChannel, destination: string): string {
  return channel === DeliveryChannel.Email ? maskEmail(destination) : maskMobile(destination);
}
