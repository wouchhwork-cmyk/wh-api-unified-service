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

export interface IssuedVerification {
  readonly verificationRefId: string;
  readonly maskedDestination: string;
  readonly deliveryChannel: DeliveryChannel;
  readonly expiresInSeconds: number;
  /**
   * The plaintext secret, returned ONLY so the caller can hand it to the
   * delivery path. It is never persisted, never logged, and never put in an API
   * response.
   */
  readonly secret: string;
}

@Injectable()
export class VerificationService {
  constructor(
    private readonly verifications: VerificationRepository,
    private readonly hasher: SecretHashService,
    private readonly config: AppConfigService,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(VerificationService.name) private readonly logger: PinoLogger,
  ) {
  }

  /**
   * Issues a challenge. Superseding the previous live row and inserting the new
   * one happen in ONE transaction — that is what the verifications_live_uniq
   * partial index requires, and it stops two live codes existing where a user
   * requesting a resend could unknowingly validate the older one.
   */
  async issue(input: IssueVerificationInput): Promise<IssuedVerification> {
    const params = this.config.verification(input.verificationKind);

    await this.assertWithinDestinationCap(input.destination, params.hourlyDestinationCap);

    const secret = this.hasher.generateSecret(params.secretShape, params.secretSize);
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

    return {
      verificationRefId: created.refId,
      maskedDestination: maskDestination(input.destination, input.deliveryChannel),
      deliveryChannel: input.deliveryChannel,
      expiresInSeconds: Math.floor(params.expiryMs / 1000),
      secret,
    };
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
  ): Promise<{ identityId: number | null; customerId: number | null; destination: string }> {
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
      destination: verification.destination,
    };
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
