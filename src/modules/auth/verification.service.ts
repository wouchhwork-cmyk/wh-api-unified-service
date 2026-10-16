import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { VerificationRepository } from '@/database/repositories/verification.repository';
import { TransactionManager } from '@/database/transaction';
import { SecretHashService } from '@/shared/crypto';
import {
  DeliveryChannel,
  VerificationKind,
  VerificationSecretShape,
  VerificationSubjectKind,
} from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { maskEmail, maskMobile } from '@/shared/utils/normalize';

export interface IssueVerificationInput {
  readonly subjectKind: VerificationSubjectKind;
  readonly identityId: number | null;
  readonly customerId: number | null;
  readonly customerIdentifierId: number | null;
  readonly enterpriseId: number | null;
  readonly verificationKind: VerificationKind;
  /** The NORMALIZED destination: a lower-cased email or an E.164 mobile. */
  readonly destination: string;
  readonly deliveryChannel: DeliveryChannel;
  readonly requestedIp: string | null;
  readonly requestedUserAgent: string | null;
}

/**
 * Everything the delivery path needs, and nothing more.
 *
 * Carried as one object rather than loose arguments so a caller cannot pair a
 * code with the wrong destination. It holds the plaintext code and the raw
 * destination, so it must never be persisted, logged, or returned from an API.
 */
export interface PendingOtpDelivery {
  readonly verificationRefId: string;
  readonly channel: DeliveryChannel;
  /** NORMALIZED: a lower-cased email or an E.164 mobile. */
  readonly destination: string;
  readonly purpose: VerificationKind;
  /** See SendOtpCommand.otpCode: named so redaction can be precise. */
  readonly otpCode: string;
  readonly expiresInSeconds: number;
}

export interface IssuedVerification {
  readonly verificationRefId: string;
  readonly maskedDestination: string;
  readonly deliveryChannel: DeliveryChannel;
  readonly expiresInSeconds: number;
  /**
   * Handed to the delivery path by the caller. Never persisted, never logged,
   * and never put in an API response.
   */
  readonly delivery: PendingOtpDelivery;
}

@Injectable()
export class VerificationService {
  constructor(
    private readonly verifications: VerificationRepository,
    private readonly hasher: SecretHashService,
    private readonly config: AppConfigService,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(VerificationService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Issues a challenge. Superseding the previous live row and inserting the new
   * one happen in ONE transaction — that is what the verifications_live_uniq
   * partial index requires, and it stops two live codes existing where a user
   * requesting a resend could unknowingly validate the older one.
   */
  async issue(input: IssueVerificationInput): Promise<IssuedVerification> {
    const params = this.config.verification(input.verificationKind);

    await this.assertWithinDestinationCap(input.destination, params.hourlyDestinationCap);

    const secret = this.mintSecret(params.secretShape, params.secretSize);
    const expiresAt = new Date(Date.now() + params.expiryMs);

    const created = await this.tx.runInTransaction(async () => {
      await this.verifications.supersedeLive({
        identityId: input.identityId,
        customerId: input.customerId,
        verificationKind: input.verificationKind,
        destination: input.destination,
      });

      return this.verifications.create({
        subjectKind: input.subjectKind,
        identityId: input.identityId,
        enterpriseId: input.enterpriseId,
        customerId: input.customerId,
        customerIdentifierId: input.customerIdentifierId,
        verificationKind: input.verificationKind,
        deliveryChannel: input.deliveryChannel,
        destination: input.destination,
        secretHash: this.hasher.hashSecret(secret),
        expiresAt,
        maxAttempts: params.maxAttempts,
        requestedIp: input.requestedIp,
        requestedUserAgent: input.requestedUserAgent,
      });
    });

    // Never the secret, never the destination — only what supports an audit.
    this.logger.info(
      { verificationKind: input.verificationKind, channel: input.deliveryChannel },
      'verification issued',
    );

    const expiresInSeconds = Math.floor(params.expiryMs / 1000);
    return {
      verificationRefId: created.refId,
      maskedDestination: maskDestination(input.destination, input.deliveryChannel),
      deliveryChannel: input.deliveryChannel,
      expiresInSeconds,
      delivery: {
        verificationRefId: created.refId,
        channel: input.deliveryChannel,
        destination: input.destination,
        purpose: input.verificationKind,
        otpCode: secret,
        expiresInSeconds,
      },
    };
  }

  /**
   * Where a code comes from.
   *
   * While realtime delivery is off nothing is sending anything, so a random code
   * would make signup impossible to complete: the fixed OTP_STATIC_CODE is what
   * keeps the flow walkable without an SMS or email vendor.
   *
   * Tokens are exempt and stay random. They travel inside a link rather than
   * through someone's fingers, so predictability would buy no convenience at
   * all while handing away the entire secret.
   *
   * Production cannot reach the fixed branch: env validation refuses to boot
   * prod with OTP_REALTIME_ENABLED=false, because a known constant would let
   * anyone verify any address they can type.
   */
  private mintSecret(shape: VerificationSecretShape, size: number): string {
    if (this.config.otp.realtimeEnabled || shape !== VerificationSecretShape.NumericCode) {
      return this.hasher.generateSecret(shape, size);
    }
    return this.config.otp.staticCode;
  }

  /**
   * Verifies a code against the live challenge for a DESTINATION rather than a
   * reference.
   *
   * Same guarantees, same code path: it resolves the reference and delegates, so
   * expiry, the atomic attempt spend, the hashed comparison and single use are
   * not reimplemented here. Only the way the row is found differs.
   */
  async verifyByDestination(
    destination: string,
    submittedSecret: string,
    expectedKind: VerificationKind,
  ): Promise<{
    identityId: number | null;
    customerId: number | null;
    enterpriseId: number | null;
    destination: string;
  }> {
    const live = await this.verifications.findLiveByDestination(destination, expectedKind);
    // Deliberately the same error an unknown reference gives: whether an
    // invitation exists for an address is not something to confirm to a guesser.
    if (!live) throw new AppException(ErrorCode.VerificationNotFound);
    return this.verify(live.refId, submittedSecret, expectedKind);
  }

  /**
   * Verifies a submitted secret against a challenge.
   *
   * The client posts back the opaque refId, never the destination — which keeps
   * the address out of a second request and removes any chance of verifying a
   * code against a different address than the one it was sent to.
   *
   * Binding is checked on THREE axes: the row, its kind, and its destination. A
   * code issued for password_reset must never satisfy email_verification.
   */
  async verify(
    verificationRefId: string,
    submittedSecret: string,
    expectedKind: VerificationKind,
  ): Promise<{
    identityId: number | null;
    customerId: number | null;
    /** The business the challenge was issued for, when it was issued for one. */
    enterpriseId: number | null;
    destination: string;
  }> {
    const verification = await this.verifications.findLiveByRefId(verificationRefId, expectedKind);
    if (!verification) throw new AppException(ErrorCode.VerificationNotFound);

    if (verification.expiresAt.getTime() <= Date.now()) {
      throw new AppException(ErrorCode.AuthCodeExpired);
    }
    /*
     * SPEND THE ATTEMPT FIRST, then compare.
     *
     * Comparing against the snapshot's counter let N concurrent requests all
     * pass the check before any increment committed, so the real number of
     * guesses was max_attempts plus in-flight concurrency. The atomic
     * conditional UPDATE is the budget: it returns null once the row is spent,
     * and no comparison happens at all in that case.
     */
    const attempts = await this.verifications.spendAttempt(verification.id);
    if (attempts === null) throw new AppException(ErrorCode.AuthCodeAttemptsExceeded);

    if (!this.hasher.verifySecret(verification.secretHash, submittedSecret)) {
      if (attempts >= verification.maxAttempts) {
        throw new AppException(ErrorCode.AuthCodeAttemptsExceeded);
      }
      throw new AppException(ErrorCode.AuthCodeInvalid);
    }

    // Single use. The conditional UPDATE is the guard: two concurrent submissions
    // of the same correct code cannot both consume it.
    const consumed = await this.verifications.consume(verification.id);
    if (!consumed) throw new AppException(ErrorCode.AuthCodeAlreadyUsed);

    return {
      identityId: verification.identityId,
      customerId: verification.customerId,
      enterpriseId: verification.enterpriseId,
      destination: verification.destination,
    };
  }

  /**
   * Issues a fresh code for a destination that already had one.
   *
   * THIS IS WHAT MAKES A BURNED CHALLENGE RECOVERABLE. `/auth/accept-invite` is
   * @Public and spends an attempt per submission, so anybody who knew a
   * colleague's address could post five wrong codes and permanently exhaust the
   * invitation — and with no resend, that account could never be entered again.
   *
   * It reveals nothing. An unknown destination, a destination with no live
   * challenge, and one still inside its cooldown are answered identically, so
   * this cannot be used to discover who has been invited.
   *
   * The cooldown is `resendCooldownMs`, which was configured per kind and read by
   * nothing. It sits alongside the hourly per-destination cap rather than
   * replacing it: the cap stops this being a free SMS pump, the cooldown stops a
   * held-down button.
   */
  async resend(input: {
    destination: string;
    verificationKind: VerificationKind;
    deliveryChannel: DeliveryChannel;
    requestedIp: string | null;
    requestedUserAgent: string | null;
  }): Promise<PendingOtpDelivery | null> {
    const live = await this.verifications.findLiveByDestination(
      input.destination,
      input.verificationKind,
    );
    if (!live) return null;

    const params = this.config.verification(input.verificationKind);
    const lastSentAt = live.lastSentAt?.getTime() ?? 0;
    if (Date.now() - lastSentAt < params.resendCooldownMs) {
      this.logger.info(
        { verificationKind: input.verificationKind },
        'resend refused — still inside the cooldown',
      );
      return null;
    }

    /*
     * A NEW ROW, not a re-send of the old one. Its attempt budget is what was
     * exhausted, and `issue` supersedes the live row inside one transaction —
     * which is what verifications_live_uniq requires, and what stops the old
     * code still being valid alongside the new one.
     */
    const issued = await this.issue({
      subjectKind: live.subjectKind,
      identityId: live.identityId,
      customerId: live.customerId,
      customerIdentifierId: live.customerIdentifierId,
      enterpriseId: live.enterpriseId,
      verificationKind: input.verificationKind,
      destination: input.destination,
      deliveryChannel: input.deliveryChannel,
      requestedIp: input.requestedIp,
      requestedUserAgent: input.requestedUserAgent,
    });

    await this.verifications.recordResend(live.id);
    return issued.delivery;
  }

  /**
   * The hourly per-destination cap. Without it this endpoint is a free SMS pump
   * billed to us.
   */
  private async assertWithinDestinationCap(destination: string, cap: number): Promise<void> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const sent = await this.verifications.countSentToDestinationSince(destination, since);
    if (sent >= cap) {
      throw new AppException(ErrorCode.AuthResendTooSoon, { retryAfterSeconds: 3600 });
    }
  }
}

function maskDestination(destination: string, channel: DeliveryChannel): string {
  return channel === DeliveryChannel.Email ? maskEmail(destination) : maskMobile(destination);
}

export { VerificationSecretShape };
