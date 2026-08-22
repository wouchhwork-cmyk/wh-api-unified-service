import { Module } from '@nestjs/common';
import { OtpSenderService } from './otp-sender.service';
import { MockOtpProvider } from './providers/mock-otp.provider';
import { OTP_PROVIDER } from './providers/otp-provider';

/**
 * Everything that talks to a human outside the product: OTPs today, and
 * transactional email and push when those arrive.
 *
 * The provider is bound here and nowhere else, so choosing a real vendor is a
 * one-line change in this file.
 */
@Module({
  providers: [
    OtpSenderService,
    MockOtpProvider,
    { provide: OTP_PROVIDER, useExisting: MockOtpProvider },
  ],
  exports: [OtpSenderService],
})
export class CommunicationModule {}
