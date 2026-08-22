import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnterpriseMemberRepository, type MembershipSummary } from '@/database/repositories/enterprise-member.repository';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { IdentityRepository } from '@/database/repositories/identity.repository';
import { SessionRepository } from '@/database/repositories/session.repository';
import { StaffMemberRepository } from '@/database/repositories/staff-member.repository';
import { SecretHashService } from '@/shared/crypto';
import {
  ActorKind,
  DeliveryChannel,
  IdentityStatus,
  MemberKind,
  VerificationKind,
  VerificationSubjectKind,
} from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { LOGIN_LOCK_DURATION_MS, MAX_FAILED_LOGINS } from '@/shared/constants';
import { normalizeEmail, normalizeMobile, isValidEmail } from '@/shared/utils/normalize';
import type { Identity } from '@/database/entities/identity.entity';
import type { LoginRequest, LoginResponse, Membership } from '@/shared/contracts/auth/login.contract';
import { TokenService } from './token.service';
import { VerificationService } from './verification.service';

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
  readonly deliverySecret?: string;
}

@Injectable()
export class AuthService {
  /** Computed once on first use; see decoyHash(). */
  private decoy: Promise<string> | undefined;

  constructor(
    private readonly identities: IdentityRepository,
    private readonly members: EnterpriseMemberRepository,
    private readonly staff: StaffMemberRepository,
    private readonly enterprises: EnterpriseRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: SecretHashService,
    private readonly tokens: TokenService,
    private readonly verifications: VerificationService,
    @InjectPinoLogger(AuthService.name) private readonly logger: PinoLogger,
  ) {
  }

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
     * The password is checked FIRST, before any account state is revealed.
     *
     * Checking lockout or disablement first told an unauthenticated caller
     * whether an address is registered, and which state it is in — a 403 for a
     * known account against a 401 for an unknown one. The work is done either
     * way, so the order costs nothing and closes the disclosure.
     */
    const passwordOk = await this.hasher.verifyPassword(identity.passwordHash, request.password);
    if (!passwordOk) {
      await this.identities.recordFailedLogin(
        identity.id,
        MAX_FAILED_LOGINS,
        LOGIN_LOCK_DURATION_MS,
      );
      throw new AppException(ErrorCode.AuthInvalidCredentials);
    }

    // Only now, with the password proven, is it safe to say why a valid
    // credential still cannot sign in.
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
        deliveryChannel:
          credential.kind === 'email' ? DeliveryChannel.Email : DeliveryChannel.Sms,
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
        deliverySecret: issued.secret,
      };
    }

    return this.completeLogin(identity, meta);
  }

  /**
   * Called after a first-login code verifies. Stamps the credential, activates
   * any pending membership, and only then issues a session.
   */
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
   * Zero active memberships is a 403, not a 401: the account exists and the
   * password was correct — there is simply nothing to sign in to.
   */
  private async completeLogin(identity: Identity, meta: RequestMetadata): Promise<LoginOutcome> {
    const memberships = await this.members.listActiveByIdentity(identity.id);
    const staffRecord = await this.staff.findActiveByIdentity(identity.id);

    await this.identities.recordSuccessfulLogin(identity.id);

    // Staff with platform-wide reach get a token with no enterprise until they
    // pick one; they have no memberships to enumerate.
    if (memberships.length === 0) {
      if (staffRecord?.hasAllEnterpriseAccess) {
        return this.issueSession(identity, null, staffRecord.staffId, meta);
      }
      throw new AppException(ErrorCode.AuthNoActiveMembership);
    }

    if (memberships.length > 1) {
      return {
        response: {
          outcome: 'enterprise_selection_required',
          selectionToken: await this.tokens.issueSelectionToken(identity.id),
          enterprises: memberships.map(toMembershipDto),
        },
      };
    }

    const only = memberships[0] as MembershipSummary;
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

    const membership = await this.members.findActiveMembership(identity.id, enterprise.id);
    if (!membership) throw new AppException(ErrorCode.AuthNoActiveMembership);

    const staffRecord = await this.staff.findActiveByIdentity(identity.id);
    return this.issueSession(identity, membership, staffRecord?.staffId ?? null, meta);
  }

  /**
   * Refresh. EVERY refresh re-checks that the membership is still active, so
   * removing someone takes effect within the access-token lifetime rather than
   * whenever their session happens to end.
   *
   * No rotation, by decision (schema.md §11): replay of a stolen refresh token is
   * therefore undetectable, and revocation is the only defence.
   */
  async refresh(
    refreshToken: string,
    enterpriseRefId: string | null,
  ): Promise<{ accessToken: string; expiresInSeconds: number; enterprise: Membership | null }> {
    const session = await this.sessions.findLiveByTokenHash(
      this.hasher.hashOpaqueToken(refreshToken),
    );
    if (!session) throw new AppException(ErrorCode.AuthSessionRevoked);

    const identity = await this.identities.findById(session.identityId);
    if (!identity) throw new AppException(ErrorCode.AuthInvalidCredentials);
    this.assertLoginable(identity);

    const staffRecord = await this.staff.findActiveByIdentity(identity.id);

    let membership: MembershipSummary | null = null;
    if (enterpriseRefId) {
      const enterprise = await this.enterprises.findByRefId(enterpriseRefId);
      if (!enterprise) throw new AppException(ErrorCode.EnterpriseNotFound);
      membership = await this.members.findActiveMembership(identity.id, enterprise.id);
      // The refresh token is valid, but the membership is gone: still a 403.
      if (!membership && !staffRecord?.hasAllEnterpriseAccess) {
        throw new AppException(ErrorCode.AuthNoActiveMembership);
      }
    }

    const accessToken = await this.tokens.issueAccessToken({
      identityId: identity.id,
      enterpriseId: membership?.enterpriseId ?? null,
      memberId: membership?.memberId ?? null,
      staffId: staffRecord?.staffId ?? null,
      actorKind: resolveActorKind(membership, staffRecord?.staffId ?? null),
      isImpersonated: isImpersonated(membership, staffRecord?.staffId ?? null),
    });

    return {
      accessToken,
      expiresInSeconds: this.tokens.accessTokenLifetimeSeconds(),
      enterprise: membership ? toMembershipDto(membership) : null,
    };
  }

  /** Switching business is a token exchange, not a re-login (schema.md §11). */
  async switchEnterprise(
    identityId: number,
    enterpriseRefId: string,
  ): Promise<{ accessToken: string; expiresInSeconds: number; enterprise: Membership }> {
    const enterprise = await this.enterprises.findByRefId(enterpriseRefId);
    if (!enterprise) throw new AppException(ErrorCode.EnterpriseNotFound);

    const membership = await this.members.findActiveMembership(identityId, enterprise.id);
    const staffRecord = await this.staff.findActiveByIdentity(identityId);

    if (!membership) {
      // Staff reach: allowed into any enterprise, and recorded as impersonation.
      if (!staffRecord?.hasAllEnterpriseAccess) {
        throw new AppException(ErrorCode.AuthNoActiveMembership);
      }
      const accessToken = await this.tokens.issueAccessToken({
        identityId,
        enterpriseId: enterprise.id,
        memberId: null,
        staffId: staffRecord.staffId,
        actorKind: ActorKind.Staff,
        isImpersonated: true,
      });
      return {
        accessToken,
        expiresInSeconds: this.tokens.accessTokenLifetimeSeconds(),
        enterprise: {
          enterpriseRefId: enterprise.refId,
          name: enterprise.name,
          slug: enterprise.slug,
          memberKind: MemberKind.Staff,
        },
      };
    }

    const accessToken = await this.tokens.issueAccessToken({
      identityId,
      enterpriseId: membership.enterpriseId,
      memberId: membership.memberId,
      staffId: staffRecord?.staffId ?? null,
      actorKind: resolveActorKind(membership, staffRecord?.staffId ?? null),
      isImpersonated: isImpersonated(membership, staffRecord?.staffId ?? null),
    });

    return {
      accessToken,
      expiresInSeconds: this.tokens.accessTokenLifetimeSeconds(),
      enterprise: toMembershipDto(membership),
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
    membership: MembershipSummary | null,
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
      enterpriseId: membership?.enterpriseId ?? null,
      memberId: membership?.memberId ?? null,
      staffId,
      actorKind: resolveActorKind(membership, staffId),
      isImpersonated: isImpersonated(membership, staffId),
    });

    if (membership) await this.members.touchLastActive(membership.memberId, membership.enterpriseId);

    return {
      response: {
        outcome: 'authenticated',
        accessToken,
        expiresInSeconds: this.tokens.accessTokenLifetimeSeconds(),
        enterprise: membership ? toMembershipDto(membership) : null,
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
  private needsVerification(identity: Identity, usedCredential: 'email' | 'mobile'): boolean {
    if (identity.lastLoginAt === null) return true;
    return usedCredential === 'email'
      ? identity.emailVerifiedAt === null
      : identity.mobileVerifiedAt === null;
  }
}

function toMembershipDto(membership: MembershipSummary): Membership {
  return {
    enterpriseRefId: membership.enterpriseRefId,
    name: membership.enterpriseName,
    slug: membership.enterpriseSlug,
    memberKind: membership.memberKind,
  };
}

function resolveActorKind(membership: MembershipSummary | null, staffId: number | null): ActorKind {
  if (membership) return ActorKind.EnterpriseMember;
  return staffId !== null ? ActorKind.Staff : ActorKind.System;
}

/** Staff acting inside an enterprise they are not a member of (schema.md §25). */
function isImpersonated(membership: MembershipSummary | null, staffId: number | null): boolean {
  return staffId !== null && membership === null;
}


