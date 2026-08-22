import type { DeliveryChannel } from '@/shared/enums';

export const OTP_PROVIDER = Symbol('OTP_PROVIDER');

export interface OtpDispatch {
  /** Opaque handle to correlate with a webhook or a vendor dashboard. */
  readonly providerMessageId: string | null;
  /** True only when the vendor accepted the message for delivery. */
  readonly accepted: boolean;
}

export interface SendOtpCommand {
  readonly channel: DeliveryChannel;
  /** Normalized: a lower-cased email or an E.164 mobile. */
  readonly destination: string;
  readonly code: string;
  /** Which flow asked, so a template can differ per purpose. */
  readonly purpose: string;
  readonly expiresInSeconds: number;
}

/**
 * The one thing a real SMS or email vendor has to implement.
 *
 * Kept this narrow on purpose: swapping Twilio for MSG91, or SES for Postmark,
 * must not touch a single line of the verification flow.
 */
export interface OtpProvider {
  readonly name: string;
  send(command: SendOtpCommand): Promise<OtpDispatch>;
}
