export { CommunicationModule } from './communication.module';
export { OtpSenderService, OtpSendMode, type OtpSendResult } from './otp-sender.service';
export {
  OTP_PROVIDER,
  type OtpProvider,
  type SendOtpCommand,
  type OtpDispatch,
} from './providers/otp-provider';
