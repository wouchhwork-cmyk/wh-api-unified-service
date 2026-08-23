import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  EnterpriseEmployeeRepository,
  type EmploymentSummary,
} from '@/database/repositories/enterprise-employee.repository';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { IdentityRepository } from '@/database/repositories/identity.repository';
import { SessionRepository } from '@/database/repositories/session.repository';
import { StaffMemberRepository } from '@/database/repositories/staff-member.repository';
import { AuditService } from '@/modules/audit';
import { SecretHashService } from '@/shared/crypto';
import {
  ActorKind,
  AuditAction,
  AuditEntityType,
  DeliveryChannel,
  EmployeeStatus,
  IdentityStatus,
  EmployeeKind,
  VerificationKind,
  VerificationSubjectKind,
} from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { LOGIN_LOCK_DURATION_MS, MAX_FAILED_LOGINS } from '@/shared/constants';
import { normalizeEmail, normalizeMobile, isValidEmail } from '@/shared/utils/normalize';
import type { Identity } from '@/database/entities/identity.entity';
import type {
  LoginRequest,
  LoginResponse,
  Employment,
} from '@/shared/contracts/auth/login.contract';
import { TokenService } from './token.service';
import { TransactionManager } from '@/database/transaction';
import { VerificationService, type PendingOtpDelivery } from './verification.service';

export interface RequestMetadata {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/** What the controller needs in order to set the refresh cookie. */
export interface SessionIssue {
  readonly refreshToken: string;
  readonly expiresAt: Date;
}

export interface LoginOutcome {
  readonly response: LoginResponse;
  readonly session?: SessionIssue;
  /** Present only when a verification was issued, for the delivery path. */
  readonly pendingDelivery?: PendingOtpDelivery;
}

@Injectable()
export class AuthService {
  /** Computed once on first use; see decoyHash(). */
  private decoy: Promise<string> | undefined;

  constructor(
    private readonly identities: IdentityRepository,
    private readonly employees: EnterpriseEmployeeRepository,
    private readonly staff: StaffMemberRepository,
    private readonly enterprises: EnterpriseRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: SecretHashService,
    private readonly tokens: TokenService,
    private readonly verifications: VerificationService,
    private readonly audit: AuditService,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(AuthService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Login. The security properties that must hold (schema.md §11):
   *
   *  - NO ENUMERATION. A wrong credential and a wrong password return the same
   *    error. The list of businesses is returned only AFTER the password verifies.
   *  - Exactly one index probe either way, and exactly one hash comparison.
   *  - Nothing is issued until any required verification passes.
   */
  async login(request: LoginRequest, meta: RequestMetadata): Promise<LoginOutcome> {
    const credential = this.resolveCredential(request);
    const identity = await this.findIdentity(credential);

    // Compare against a REAL argon2 hash when no identity exists, so a missing
    // account and a wrong password cost the same work. A malformed placeholder
    // would be rejected by the parser in microseconds, which is precisely the
    // timing oracle this is meant to remove.
    if (!identity) {
      await this.hasher.verifyPassword(await this.decoyHash(), request.password);
      throw new AppException(ErrorCode.AuthInvalidCredentials);
    }

    /*
     * THE LOCK IS READ BEFORE THE PASSWORD BRANCH, and the hash is compared
     * either way.
     *
     * The lock used to be consulted only on the SUCCESS path, so a wrong
     * password incremented the counter and was never once stopped by it: the
     * control that exists to bound guessing bounded nothing. It is evaluated
     * here instead, and a locked account terminates the attempt whatever the
     * password was.
     *
     * The comparison still happens first so that TIMING does not reveal the
     * lock — a locked account must cost an attacker the same argon2id work as
     * an unlocked one, or the lock becomes the oracle the ordering was designed
     * to avoid.
     */
    const locked = identity.lockedUntil !== null && identity.lockedUntil.getTime() > Date.now();
    const passwordOk = await this.hasher.verifyPassword(identity.passwordHash, request.password);

    if (locked && !passwordOk) {
      /*
       * The GENERIC failure, and no counter write. Generic because a wrong
       * guess must not learn that this address is locked — which would confirm
       * the address exists. No counter write because the lock is already
       * running: counting further would only let a third party keep extending
       * somebody else's lockout.
       */
      throw new AppException(ErrorCode.AuthInvalidCredentials);
    }

    if (!passwordOk) {
      await this.identities.recordFailedLogin(
        identity.id,
        MAX_FAILED_LOGINS,
        LOGIN_LOCK_DURATION_MS,
      );
      throw new AppException(ErrorCode.AuthInvalidCredentials);
    }

    /*
     * The password is proven, so it is now safe to say WHY a valid credential
     * still cannot sign in — including the lock, with the time remaining. That
     * disclosure is deliberate and only reaches somebody who already has the
     * password.
     */
    this.assertLoginable(identity);

    // --- the password is proven from here on ------------------------------

    const needsVerification = this.needsVerification(identity, credential.kind);
    if (needsVerification) {
      const issued = await this.verifications.issue({
        subjectKind: VerificationSubjectKind.Identity,
        identityId: identity.id,
        customerId: null,
        customerIdentifierId: null,
        enterpriseId: null,
        verificationKind: VerificationKind.FirstLogin,
        destination: credential.value,
        deliveryChannel: credential.kind === 'email' ? DeliveryChannel.Email : DeliveryChannel.Sms,
        requestedIp: meta.ipAddress,
        requestedUserAgent: meta.userAgent,
      });

      return {
        response: {
          outcome: 'verification_required',
          verificationRefId: issued.verificationRefId,
          deliveryChannel: issued.deliveryChannel,
          maskedDestination: issued.maskedDestination,
          expiresInSeconds: issued.expiresInSeconds,
        },
        pendingDelivery: issued.delivery,
      };
    }

    return this.completeLogin(identity, meta);
  }

  /**
   * Called after a first-login code verifies. Stamps the credential, activates
   * any pending employment, and only then issues a session.
   */
  /**
   * Completes an invitation: the person proves the address AND chooses a password
   * in one step, and is signed in.
   *
   * Both writes happen together, because "the code was accepted but the password
   * was not set" leaves an account that can never be entered — the code is spent,
   * and the password is still the random one nobody knows.
   *
   * Their employment moves invited -> active here and not before. An account that
   * can act before the address is proven is an account somebody else can take by
   * guessing a colleague's email.
   */
  async completeInvite(
    identityId: number,
    enterpriseId: number | null,
    verifiedDestination: string,
    newPassword: string,
    meta: RequestMetadata,
  ): Promise<LoginOutcome> {
    const identity = await this.identities.findById(identityId);
    if (!identity) throw new AppException(ErrorCode.AuthInvalidCredentials);

    await this.tx.runInTransaction(async () => {
      await this.identities.updatePasswordHash(
        identity.id,
        await this.hasher.hashPassword(newPassword),
      );

      // The column is chosen by matching the destination that was actually
      // proven, so accepting an email invite can never mark a mobile verified.
      if (identity.email !== null && identity.email === verifiedDestination) {
        await this.identities.markCredentialVerified(identity.id, 'email');
      } else if (identity.mobile !== null && identity.mobile === verifiedDestination) {
        await this.identities.markCredentialVerified(identity.id, 'mobile');
      }

      if (enterpriseId !== null) {
        const employment = await this.employees.findByIdentity(enterpriseId, identity.id);
        if (employment && employment.status === EmployeeStatus.Invited) {
          await this.employees.activate(employment.employeeId, enterpriseId);
        }
      }

      /*
       * SETTING A PASSWORD SIGNS EVERY OTHER DEVICE OUT.
       *
       * It did not, and this path is where that matters most: an identity is
       * global, so accepting a second business's invitation REPLACES the
       * password this person already used elsewhere. Anyone holding a session
       * minted under the old one kept it — which is the textbook reason a
       * password change revokes sessions, and the exact case
       * revokeAllForIdentity was written for and never called from.
       *
       * Inside the transaction, so a rolled-back password change does not sign
       * anybody out for nothing. The caller is issued a fresh session
       * immediately afterwards, so the person doing this is not logged out of
       * the request they are making.
       */
      const revoked = await this.sessions.revokeAllForIdentity(identity.id);
      if (revoked > 0) {
        this.logger.info(
          { identityId: identity.id, revoked },
          'password set — existing sessions for this identity were revoked',
        );
      }
    });

    this.logger.info({ enterpriseId }, 'invitation accepted and password set');

    // Re-read: the row just changed underneath us, and completeLogin decides what
    // to issue from the current state.
    const refreshed = await this.identities.findById(identityId);
    if (!refreshed) throw new AppException(ErrorCode.AuthInvalidCredentials);
    this.assertLoginable(refreshed);
    return this.completeLogin(refreshed, meta);
  }

  async completeVerifiedLogin(
    identityId: number,
    verifiedDestination: string,
    meta: RequestMetadata,
  ): Promise<LoginOutcome> {
    const identity = await this.identities.findById(identityId);
    if (!identity) throw new AppException(ErrorCode.AuthInvalidCredentials);
    this.assertLoginable(identity);

    /*
     * Stamp the credential that was just proven. Without this,
     * needsVerification() stays true forever: every login issues another code,
     * and once the hourly per-destination cap is reached the account cannot be
     * signed into at all.
     *
     * The column is chosen by matching the verified DESTINATION against the
     * identity's own values, so verifying an email can never mark a mobile
     * verified.
     */
    if (identity.email !== null && identity.email === verifiedDestination) {
      await this.identities.markCredentialVerified(identity.id, 'email');
    } else if (identity.mobile !== null && identity.mobile === verifiedDestination) {
      await this.identities.markCredentialVerified(identity.id, 'mobile');
    }

    return this.completeLogin(identity, meta);
  }

  /**
   * Issues a session, or asks the client to choose a business.
   *
   * Zero active employments is a 403, not a 401: the account exists and the
   * password was correct — there is simply nothing to sign in to.
   */
  private async completeLogin(identity: Identity, meta: RequestMetadata): Promise<LoginOutcome> {
    const employments = await this.employees.listActiveByIdentity(identity.id);
    const staffRecord = await this.staff.findActiveByIdentity(identity.id);

    await this.identities.recordSuccessfulLogin(identity.id);

    // Staff with platform-wide reach get a token with no enterprise until they
    // pick one; they have no employments to enumerate.
    if (employments.length === 0) {
      if (staffRecord?.hasAllEnterpriseAccess) {
        return this.issueSession(identity, null, staffRecord.staffId, meta);
      }
      throw new AppException(ErrorCode.AuthNoActiveEmployment);
    }

    if (employments.length > 1) {
      return {
        response: {
          outcome: 'enterprise_selection_required',
          selectionToken: await this.tokens.issueSelectionToken(identity.id),
          enterprises: employments.map(toEmploymentDto),
        },
      };
    }

    const only = employments[0] as EmploymentSummary;
    return this.issueSession(identity, only, staffRecord?.staffId ?? null, meta);
  }

  /** Exchanges a selection token for a session scoped to the chosen business. */
  async selectEnterprise(
    selectionToken: string,
    enterpriseRefId: string,
    meta: RequestMetadata,
  ): Promise<LoginOutcome> {
    const claims = await this.tokens.verifySelectionToken(selectionToken);

    const identity = await this.identities.findById(claims.identityId);
    if (!identity) throw new AppException(ErrorCode.AuthInvalidCredentials);
    this.assertLoginable(identity);

    const enterprise = await this.enterprises.findByRefId(enterpriseRefId);
    if (!enterprise) throw new AppException(ErrorCode.EnterpriseNotFound);

    const employment = await this.employees.findActiveEmployment(identity.id, enterprise.id);
    if (!employment) throw new AppException(ErrorCode.AuthNoActiveEmployment);

    const staffRecord = await this.staff.findActiveByIdentity(identity.id);
    return this.issueSession(identity, employment, staffRecord?.staffId ?? null, meta);
  }

  /**
   * Refresh. EVERY refresh re-checks that the employment is still active, so
   * removing someone takes effect within the access-token lifetime rather than
   * whenever their session happens to end.
   *
   * No rotation, by decision (schema.md §11): replay of a stolen refresh token is
   * therefore undetectable, and revocation is the only defence.
   */
  async refresh(
    refreshToken: string,
    enterpriseRefId: string | null,
  ): Promise<{ accessToken: string; expiresInSeconds: number; enterprise: Employment | null }> {
    const session = await this.sessions.findLiveByTokenHash(
      this.hasher.hashOpaqueToken(refreshToken),
    );
    if (!session) throw new AppException(ErrorCode.AuthSessionRevoked);

    const identity = await this.identities.findById(session.identityId);
    if (!identity) throw new AppException(ErrorCode.AuthInvalidCredentials);
    this.assertLoginable(identity);

    const staffRecord = await this.staff.findActiveByIdentity(identity.id);

    let employment: EmploymentSummary | null = null;
    if (enterpriseRefId) {
      const enterprise = await this.enterprises.findByRefId(enterpriseRefId);
      if (!enterprise) throw new AppException(ErrorCode.EnterpriseNotFound);
      employment = await this.employees.findActiveEmployment(identity.id, enterprise.id);
      // The refresh token is valid, but the employment is gone: still a 403.
      if (!employment && !staffRecord?.hasAllEnterpriseAccess) {
        throw new AppException(ErrorCode.AuthNoActiveEmployment);
      }
    }

    const accessToken = await this.tokens.issueAccessToken({
      identityId: identity.id,
      enterpriseId: employment?.enterpriseId ?? null,
      employeeId: employment?.employeeId ?? null,
      staffId: staffRecord?.staffId ?? null,
      actorKind: resolveActorKind(employment, staffRecord?.staffId ?? null),
      isImpersonated: isImpersonated(
        employment,
        staffRecord?.staffId ?? null,
        employment?.enterpriseId ?? null,
      ),
    });

    return {
      accessToken,
      expiresInSeconds: this.tokens.accessTokenLifetimeSeconds(),
      enterprise: employment ? toEmploymentDto(employment) : null,
    };
  }

  /** Switching business is a token exchange, not a re-login (schema.md §11). */
  async switchEnterprise(
    identityId: number,
    enterpriseRefId: string,
  ): Promise<{ accessToken: string; expiresInSeconds: number; enterprise: Employment }> {
    const enterprise = await this.enterprises.findByRefId(enterpriseRefId);
    if (!enterprise) throw new AppException(ErrorCode.EnterpriseNotFound);

    const employment = await this.employees.findActiveEmployment(identityId, enterprise.id);
    const staffRecord = await this.staff.findActiveByIdentity(identityId);

    if (!employment) {
      // Staff reach: allowed into any enterprise, and recorded as impersonation.
      if (!staffRecord?.hasAllEnterpriseAccess) {
        throw new AppException(ErrorCode.AuthNoActiveEmployment);
      }
      const accessToken = await this.tokens.issueAccessToken({
        identityId,
        enterpriseId: enterprise.id,
        employeeId: null,
        staffId: staffRecord.staffId,
        actorKind: ActorKind.Staff,
        isImpersonated: true,
      });

      /*
       * RECORDED, not merely flagged on the token.
       *
       * The comment above this branch said "recorded as impersonation" and
       * nothing was recorded anywhere: is_impersonated went onto the token, and
       * from there onto the audit rows of whatever the staff member CHANGED —
       * so entering an account and only reading it left no trace at all. That is
       * the single event a customer is most entitled to see in an access log.
       */
      await this.audit.record({
        action: AuditAction.Impersonated,
        entityType: AuditEntityType.Enterprise,
        entityId: enterprise.id,
        enterpriseId: enterprise.id,
        metadata: { staffId: staffRecord.staffId, via: 'switch-enterprise' },
      });

      return {
        accessToken,
        expiresInSeconds: this.tokens.accessTokenLifetimeSeconds(),
        enterprise: {
          enterpriseRefId: enterprise.refId,
          name: enterprise.name,
          slug: enterprise.slug,
          employeeKind: EmployeeKind.Support,
        },
      };
    }

    const accessToken = await this.tokens.issueAccessToken({
      identityId,
      enterpriseId: employment.enterpriseId,
      employeeId: employment.employeeId,
      staffId: staffRecord?.staffId ?? null,
      actorKind: resolveActorKind(employment, staffRecord?.staffId ?? null),
      isImpersonated: isImpersonated(
        employment,
        staffRecord?.staffId ?? null,
        employment?.enterpriseId ?? null,
      ),
    });

    return {
      accessToken,
      expiresInSeconds: this.tokens.accessTokenLifetimeSeconds(),
      enterprise: toEmploymentDto(employment),
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const session = await this.sessions.findLiveByTokenHash(
      this.hasher.hashOpaqueToken(refreshToken),
    );
    // Logging out an already-dead session is a success, not an error.
    if (session) await this.sessions.revoke(session.id);
  }

  private async issueSession(
    identity: Identity,
    employment: EmploymentSummary | null,
    staffId: number | null,
    meta: RequestMetadata,
  ): Promise<LoginOutcome> {
    const refreshToken = this.hasher.generateOpaqueToken();
    const expiresAt = this.tokens.refreshTokenExpiry();

    await this.sessions.create({
      identityId: identity.id,
      refreshTokenHash: this.hasher.hashOpaqueToken(refreshToken),
      deviceInfo: meta.userAgent,
      ipAddress: meta.ipAddress,
      expiresAt,
    });

    const accessToken = await this.tokens.issueAccessToken({
      identityId: identity.id,
      enterpriseId: employment?.enterpriseId ?? null,
      employeeId: employment?.employeeId ?? null,
      staffId,
      actorKind: resolveActorKind(employment, staffId),
      isImpersonated: isImpersonated(employment, staffId, employment?.enterpriseId ?? null),
    });

    if (employment)
      await this.employees.touchLastActive(employment.employeeId, employment.enterpriseId);

    return {
      response: {
        outcome: 'authenticated',
        accessToken,
        expiresInSeconds: this.tokens.accessTokenLifetimeSeconds(),
        enterprise: employment ? toEmploymentDto(employment) : null,
      },
      session: { refreshToken, expiresAt },
    };
  }

  private resolveCredential(request: LoginRequest): {
    kind: 'email' | 'mobile';
    value: string;
  } {
    if (request.email !== undefined) {
      const normalized = normalizeEmail(request.email);
      if (!isValidEmail(normalized)) throw new AppException(ErrorCode.InvalidEmail);
      return { kind: 'email', value: normalized };
    }
    if (request.mobile !== undefined) {
      const normalized = normalizeMobile(request.mobile);
      if (!normalized) throw new AppException(ErrorCode.InvalidMobile);
      return { kind: 'mobile', value: normalized.canonical };
    }
    throw new AppException(ErrorCode.CredentialRequired);
  }

  /**
   * A genuine argon2id hash of a random value, produced with the configured
   * parameters and reused. It must be real: verifyPassword on a malformed hash
   * returns false immediately, leaving the no-such-account path measurably
   * faster than the wrong-password path.
   */
  private async decoyHash(): Promise<string> {
    this.decoy ??= this.hasher.hashPassword(this.hasher.generateOpaqueToken(16));
    return this.decoy;
  }

  private async findIdentity(credential: {
    kind: 'email' | 'mobile';
    value: string;
  }): Promise<Identity | null> {
    return credential.kind === 'email'
      ? this.identities.findByEmail(credential.value)
      : this.identities.findByMobile(credential.value);
  }

  private assertLoginable(identity: Identity): void {
    if (identity.status === IdentityStatus.Disabled) {
      throw new AppException(ErrorCode.AuthAccountDisabled);
    }
    if (identity.lockedUntil && identity.lockedUntil.getTime() > Date.now()) {
      throw new AppException(ErrorCode.AuthAccountLocked, {
        retryAfterSeconds: Math.ceil((identity.lockedUntil.getTime() - Date.now()) / 1000),
      });
    }
  }

  /**
   * Verification is required on a first login, or whenever the credential the
   * person just used is not yet verified.
   */
  /**
   * A challenge is issued when the credential being used has not been PROVEN —
   * not merely because this is somebody's first login.
   *
   * For a business owner the two are the same thing in practice: signup leaves
   * both credentials unverified, and it is the verification itself that stamps
   * them, so a new owner is still challenged exactly as before.
   *
   * They come apart for an account provisioned from configuration. An operator
   * put that credential in the deployment environment, which is a stronger claim
   * of control than any code sent to it — and if the address cannot receive SMS
   * or email, "first login always needs a code" would lock the account out of
   * itself permanently. Basing the rule on proof rather than on login count
   * keeps the guarantee (an unproven credential can never hold a session) while
   * letting a proven one straight through.
   */
  private needsVerification(identity: Identity, usedCredential: 'email' | 'mobile'): boolean {
    return usedCredential === 'email'
      ? identity.emailVerifiedAt === null
      : identity.mobileVerifiedAt === null;
  }
}

function toEmploymentDto(employment: EmploymentSummary): Employment {
  return {
    enterpriseRefId: employment.enterpriseRefId,
    name: employment.enterpriseName,
    slug: employment.enterpriseSlug,
    employeeKind: employment.employeeKind,
  };
}

function resolveActorKind(employment: EmploymentSummary | null, staffId: number | null): ActorKind {
  if (employment) return ActorKind.Employee;
  return staffId !== null ? ActorKind.Staff : ActorKind.System;
}

/**
 * Staff acting INSIDE an enterprise they are not a employee of (schema.md §25).
 *
 * All three conditions matter, and the enterprise is the one most easily
 * forgotten: a platform admin holding a token with no enterprise scope at all is
 * not impersonating anybody — they are doing their own job on our own console.
 * Marking that as impersonation would put `is_impersonated = true` on every
 * platform audit row and destroy the only signal the flag exists to give, which
 * is "one of ours was inside a customer's account".
 */
function isImpersonated(
  employment: EmploymentSummary | null,
  staffId: number | null,
  enterpriseId: number | null,
): boolean {
  return staffId !== null && employment === null && enterpriseId !== null;
}
