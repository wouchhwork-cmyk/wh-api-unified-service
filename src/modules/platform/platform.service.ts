import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  PlatformAdminRepository,
  type PlatformChannelRow,
  type PlatformEnterpriseOwner,
  type PlatformFeatureRow,
  type PlatformOverview,
} from '@/database/repositories/platform-admin.repository';
import { AuditService } from '@/modules/audit';
import { StaffMemberRepository } from '@/database/repositories/staff-member.repository';
import { clampLimit } from '@/shared/utils/page-limit';
import { RequestContext } from '@/shared/context';
import { decodeKeysetCursor, encodeKeysetCursor } from '@/shared/utils/keyset-cursor';
import {
  AuditAction,
  AuditEntityType,
  DeliveryChannel,
  ENTERPRISE_FEATURE_TRANSITIONS,
  ENTERPRISE_STATUS_TRANSITIONS,
  EnterpriseFeatureStatus,
  EnterpriseStatus,
  StaffStatus,
  VerificationKind,
  VerificationSecretShape,
  VerificationSubjectKind,
} from '@/shared/enums';
import { IdentityRepository } from '@/database/repositories/identity.repository';
import { SessionRepository } from '@/database/repositories/session.repository';
import { VerificationService } from '@/modules/auth/verification.service';
import { SecretHashService } from '@/shared/crypto';
import { TransactionManager } from '@/database/transaction';
import { explainStatusDenial, mayChangeStatus } from '@/shared/rbac';
import { normalizeEmail, normalizeMobile } from '@/shared/utils/normalize';
import type { PlatformStaffInviteRequest } from '@/shared/contracts/platform/platform.contract';
import { AppException, ErrorCode } from '@/shared/errors';
import { maskEmail, maskMobile } from '@/shared/utils/normalize';

/** One of our own people, as the console shows them. */
export interface StaffListItem {
  readonly refId: string;
  readonly name: string;
  readonly email: string | null;
  readonly status: string;
  /** True means the platform admin: every staff permission, every business. */
  readonly hasAllEnterpriseAccess: boolean;
  readonly roles: readonly string[];
  readonly lastLoginAt: Date | null;
}

/** What a client is allowed to see about a business. No internal ids. */
export interface EnterpriseListItem {
  readonly refId: string;
  readonly name: string;
  readonly slug: string;
  readonly email: string;
  readonly mobile: string | null;
  readonly status: EnterpriseStatus;
  readonly city: string | null;
  readonly country: string;
  readonly timezone: string;
  readonly createdAt: Date;
  readonly counts: {
    readonly employees: number;
    readonly channels: number;
    readonly connections: number;
    readonly customers: number;
    readonly conversations: number;
    readonly activeFeatures: number;
    readonly pendingFeatures: number;
  };
}

export interface EnterpriseDetail extends EnterpriseListItem {
  readonly owner: {
    readonly name: string;
    readonly email: string | null;
    readonly mobile: string | null;
    readonly emailVerified: boolean;
    readonly mobileVerified: boolean;
    readonly lastLoginAt: Date | null;
  } | null;
  readonly features: readonly PlatformFeatureRow[];
  readonly channels: readonly PlatformChannelRow[];
}

@Injectable()
export class PlatformService {
  constructor(
    private readonly platform: PlatformAdminRepository,
    private readonly staff: StaffMemberRepository,
    private readonly audit: AuditService,
    private readonly identities: IdentityRepository,
    private readonly sessions: SessionRepository,
    private readonly verifications: VerificationService,
    private readonly hasher: SecretHashService,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(PlatformService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Adds one of Wouchh's own people.
   *
   * THE RULE THAT MAKES THIS SAFE TO EXPOSE AT ALL: an address that already
   * belongs to somebody is refused outright.
   *
   * A tenant invite does the opposite on purpose — identities are global, one
   * human has one password however many businesses they work for, so inviting
   * an existing address attaches a new employment to it. Doing that here would
   * mean typing a customer's email into this form and handing that customer
   * staff reach over every business on the platform. The bootstrap refuses the
   * same collision for the same reason, and this is the same door.
   *
   * So a staff account is always a NEW identity. Somebody who is genuinely both
   * a customer and a colleague needs two addresses, which is the ordinary
   * arrangement for a privileged internal account.
   *
   * Everybody created here is SCOPED staff. `has_all_enterprise_access` is not
   * a parameter and cannot be set from this endpoint — see the contract.
   */
  async inviteStaff(
    actingStaffId: number,
    request: PlatformStaffInviteRequest,
  ): Promise<{ refId: string; name: string; status: StaffStatus; roles: string[] }> {
    const email = request.email ? normalizeEmail(request.email) : null;
    const mobile = request.mobile ? normalizeMobile(request.mobile) : null;
    if (!email && !mobile) throw new AppException(ErrorCode.CredentialRequired);

    const wanted = await this.resolveStaffRoles(request.roleRefIds ?? []);

    /*
     * A placeholder nobody knows and nobody can use. The invite is the only way
     * in, and accepting it replaces this. Generated rather than fixed so two
     * staff created in the same minute do not share a hash.
     */
    const placeholderPasswordHash = await this.hasher.hashPassword(
      this.hasher.generateSecret(VerificationSecretShape.Token, 32),
    );

    const created = await this.tx.runInTransaction(async () => {
      const existing =
        (email ? await this.identities.findByEmail(email) : null) ??
        (mobile ? await this.identities.findByMobile(mobile.canonical) : null);

      if (existing) {
        /*
         * Deliberately the same answer whether that address belongs to a
         * customer, to an existing colleague, or to a suspended account. The
         * caller is a platform admin and could look any of it up — but this
         * endpoint is not the place to turn an email into a statement about
         * who uses the product.
         */
        throw new AppException(ErrorCode.EmployeeAlreadyExists, {
          details: [{ field: email ? 'email' : 'mobile', issue: 'that address is already in use' }],
        });
      }

      const identity = await this.identities.create({
        email,
        mobile: mobile?.canonical ?? null,
        mobileCountryCode: mobile?.countryCode ?? null,
        mobileCallingCode: mobile?.callingCode ?? null,
        mobileNationalNumber: mobile?.nationalNumber ?? null,
        passwordHash: placeholderPasswordHash,
        firstName: request.firstName,
        lastName: request.lastName ?? null,
      });

      const staff = await this.staff.create({
        identityId: identity.id,
        // Never from this endpoint. Promotion is a deployment decision.
        hasAllEnterpriseAccess: false,
        // Invited, not active: they have proved nothing yet.
        status: StaffStatus.Invited,
      });

      if (wanted.length > 0) {
        await this.staff.replaceStaffRoles({
          staffId: staff.staffId,
          roleIds: wanted.map((role) => role.id),
          grantedByStaffId: actingStaffId,
        });
      }

      return { identity, staff };
    });

    // Outside the transaction: issuing a verification writes its own rows and
    // holding the creation open across it would widen it for no benefit.
    const destination = email ?? mobile?.canonical;
    if (!destination) throw new AppException(ErrorCode.CredentialRequired);

    await this.verifications.issue({
      subjectKind: VerificationSubjectKind.Identity,
      identityId: created.identity.id,
      customerId: null,
      customerIdentifierId: null,
      /*
       * NO ENTERPRISE. This is what makes `completeInvite` treat the acceptance
       * as a staff one: there is no employment to activate, and the staff row
       * is what moves instead.
       */
      enterpriseId: null,
      verificationKind: VerificationKind.EmployeeInvite,
      destination,
      deliveryChannel: email ? DeliveryChannel.Email : DeliveryChannel.Sms,
      requestedIp: null,
      requestedUserAgent: null,
    });

    await this.audit.record({
      action: AuditAction.Created,
      entityType: AuditEntityType.StaffMember,
      entityId: created.staff.staffId,
      enterpriseId: null,
      changes: { status: { from: null, to: StaffStatus.Invited } },
      metadata: { roles: wanted.map((role) => role.name), invitedByStaffId: actingStaffId },
    });

    this.logger.info(
      { staffId: created.staff.staffId, roleCount: wanted.length },
      'staff member created and invited',
    );

    return {
      refId: created.staff.refId,
      name: [request.firstName, request.lastName].filter(Boolean).join(' '),
      status: StaffStatus.Invited,
      roles: wanted.map((role) => role.name),
    };
  }

  /**
   * Suspends or reinstates one of our own people.
   *
   * Three guards, and each of them is a way the console could otherwise be
   * locked or bypassed:
   *
   *   - NOBODY ACTS ON THEMSELVES, as with roles. An admin who suspended
   *     themselves would be relying on a second admin existing.
   *   - THE LAST PLATFORM ADMIN STAYS. Staff have no signup route and no
   *     self-serve recovery at all, so suspending the final one leaves a
   *     console nobody on earth can enter until somebody redeploys with
   *     PLATFORM_ADMIN_* set. Counted behind a lock, because two admins
   *     suspending each other at once would each read "one other remains".
   *   - NO ADMINISTRATIVE ACTIVATION. `mayChangeStatus` refuses anything that
   *     would move a row into `active` without the person having accepted.
   */
  async setStaffStatus(
    actingStaffId: number,
    staffRefId: string,
    status: StaffStatus,
    reason: string | null,
  ): Promise<{ refId: string; from: StaffStatus; to: StaffStatus }> {
    const target = await this.staff.findByRefId(staffRefId);
    if (!target) throw new AppException(ErrorCode.EmployeeNotFound);

    if (target.id === actingStaffId) {
      throw new AppException(ErrorCode.PermissionDenied, {
        details: [{ field: 'refId', issue: 'you cannot change your own status' }],
      });
    }

    const denial = mayChangeStatus(target.status, status, target.everAccepted);
    if (denial) {
      throw new AppException(ErrorCode.InvalidStateTransition, {
        details: [{ field: 'status', issue: explainStatusDenial(denial) }],
      });
    }

    const applied = await this.tx.runInTransaction(async () => {
      if (status === StaffStatus.Suspended && target.hasAllEnterpriseAccess) {
        await this.staff.lockPlatformAdmins();
        const others = await this.staff.countOtherActivePlatformAdmins(target.id);
        if (others === 0) {
          throw new AppException(ErrorCode.ValidationFailed, {
            details: [
              {
                field: 'refId',
                issue: 'this is the last active platform admin; there would be no way back in',
              },
            ],
          });
        }
      }
      return this.staff.setStatus(target.id, target.status, status);
    });
    if (!applied) throw new AppException(ErrorCode.ConcurrentModification);

    /*
     * Suspension ends their sessions — but only somebody who actually got in.
     *
     * A cancelled invite has no session of ours to revoke, and unlike the
     * tenant side there is no cross-tenant blast radius to worry about here:
     * this endpoint refuses to attach to an existing identity, so a staff
     * identity is only ever a staff identity.
     */
    if (status === StaffStatus.Suspended && target.everAccepted) {
      const revoked = await this.sessions.revokeAllForIdentity(target.identityId);
      this.logger.info({ staffId: target.id, revoked }, 'staff suspended — sessions revoked');
    }

    await this.audit.record({
      action: AuditAction.Updated,
      entityType: AuditEntityType.StaffMember,
      entityId: target.id,
      enterpriseId: null,
      changes: { status: { from: target.status, to: status } },
      metadata: reason ? { reason } : {},
    });

    return { refId: staffRefId, from: target.status, to: status };
  }

  /** Resolves role refIds against the staff templates, refusing anything else. */
  private async resolveStaffRoles(
    roleRefIds: readonly string[],
  ): Promise<{ id: number; name: string }[]> {
    if (roleRefIds.length === 0) return [];

    const options = await this.staff.listStaffRoleOptions();
    const wanted = options.filter((option) => roleRefIds.includes(option.refId));
    // An enterprise role's refId resolves to nothing here, which is the point:
    // the options are the NULL-enterprise staff-scoped templates and nothing else.
    if (wanted.length !== roleRefIds.length) throw new AppException(ErrorCode.RoleNotFound);
    return wanted;
  }

  /**
   * Wouchh's own people and what each of them may do.
   *
   * Until `staff_roles` existed there was nothing to show: every platform admin
   * had identical authority, and the `support` and `ops` roles were two seeded
   * rows nothing could point at (backlog B3).
   */
  async listStaff(): Promise<readonly StaffListItem[]> {
    const rows = await this.staff.listWithRoles();
    return rows.map((row) => ({
      refId: row.refId,
      name: [row.firstName, row.lastName].filter(Boolean).join(' '),
      // Masked like every other contact detail. An internal list is still the
      // most screenshotted kind of screen.
      email: row.email ? maskEmail(row.email) : null,
      status: row.status,
      hasAllEnterpriseAccess: row.hasAllEnterpriseAccess,
      roles: row.roles,
      lastLoginAt: row.lastLoginAt,
    }));
  }

  /** The staff roles a platform admin can hand out. */
  async listStaffRoleOptions(): Promise<readonly { refId: string; name: string }[]> {
    const rows = await this.staff.listStaffRoleOptions();
    return rows.map((row) => ({ refId: row.refId, name: row.name }));
  }

  /**
   * Replaces exactly which staff roles somebody holds.
   *
   * NOBODY CHANGES THEIR OWN. The realistic failure is an admin narrowing
   * themselves out of the console with no second admin to undo it — the same
   * reasoning as the tenant-side self guard, and here there is no support path
   * at all because staff have no signup route.
   *
   * A platform admin — `has_all_enterprise_access` — is refused outright:
   * their permissions come from the flag, so roles would be recorded and do
   * nothing, which is worse than refusing. Narrowing one is a deliberate act
   * on the flag, not a side effect of granting roles.
   */
  async setStaffRoles(
    actingStaffId: number,
    staffRefId: string,
    roleRefIds: readonly string[],
  ): Promise<void> {
    const target = await this.staff.findByRefId(staffRefId);
    if (!target) throw new AppException(ErrorCode.EmployeeNotFound);

    if (target.id === actingStaffId) {
      throw new AppException(ErrorCode.PermissionDenied, {
        details: [{ field: 'refId', issue: 'you cannot change your own access' }],
      });
    }
    if (target.hasAllEnterpriseAccess) {
      throw new AppException(ErrorCode.ValidationFailed, {
        details: [
          {
            field: 'refId',
            issue: 'this person is a platform admin; roles would have no effect',
          },
        ],
      });
    }

    const options = await this.staff.listStaffRoleOptions();
    const wanted = options.filter((option) => roleRefIds.includes(option.refId));
    if (wanted.length !== roleRefIds.length) throw new AppException(ErrorCode.RoleNotFound);

    await this.staff.replaceStaffRoles({
      staffId: target.id,
      roleIds: wanted.map((role) => role.id),
      grantedByStaffId: actingStaffId,
    });

    await this.audit.record({
      action: AuditAction.RoleGranted,
      entityType: AuditEntityType.StaffMember,
      entityId: target.id,
      enterpriseId: null,
      metadata: { roles: wanted.map((role) => role.name) },
    });
    this.logger.info({ roleCount: wanted.length }, 'staff roles replaced');
  }

  async overview(): Promise<PlatformOverview> {
    return this.platform.overview();
  }

  async listEnterprises(query: {
    search: string | null;
    status: EnterpriseStatus | null;
    limit: number | null;
    cursor: string | null;
  }): Promise<{ items: EnterpriseListItem[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = clampLimit(query.limit);

    const rows = await this.platform.listEnterprises({
      search: query.search,
      status: query.status,
      // One extra row answers "is there another page" without a second COUNT
      // over the same predicate.
      limit: limit + 1,
      cursor: decodeEnterpriseCursor(query.cursor),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(toListItem),
      nextCursor: hasMore && last ? encodeKeysetCursor(last.createdAt, last.internalId) : null,
      hasMore,
    };
  }

  async getEnterprise(refId: string): Promise<EnterpriseDetail> {
    const row = await this.platform.findEnterpriseByRefId(refId);
    if (!row) throw new AppException(ErrorCode.EnterpriseNotFound);

    // Independent reads, so they go together rather than one after another.
    const [owner, features, channels] = await Promise.all([
      this.platform.findOwner(row.internalId),
      this.platform.listFeatures(row.internalId),
      this.platform.listChannels(row.internalId),
    ]);

    /*
     * A READ IS AUDITED HERE, which is unusual and deliberate.
     *
     * Every write in this console records one and every read recorded nothing —
     * so a platform admin could open a customer's account, see its owner's name,
     * email, mobile, connected channels and feature entitlements, and leave no
     * trace whatsoever. "Who at Wouchh looked at my business" is the question a
     * customer is most entitled to have an answer to, and it had none.
     *
     * The LIST is deliberately not audited: it is aggregate metadata across
     * every tenant, so a row per page view would bury the reads that matter.
     */
    await this.audit.record({
      action: AuditAction.Viewed,
      entityType: AuditEntityType.Enterprise,
      entityId: row.internalId,
      enterpriseId: row.internalId,
      metadata: { surface: 'platform-console' },
    });

    return {
      ...toListItem(row),
      owner: owner ? toOwner(owner) : null,
      features,
      channels,
    };
  }

  /**
   * Switches a business on or off.
   *
   * The transition is checked against ENTERPRISE_STATUS_TRANSITIONS rather than
   * accepting any target, so "suspend an already suspended business" is a clear
   * 409 instead of a silent no-op that looks like success.
   */
  async setEnterpriseStatus(
    refId: string,
    status: EnterpriseStatus,
    reason: string | null,
  ): Promise<{ refId: string; from: EnterpriseStatus; to: EnterpriseStatus }> {
    const found = await this.platform.findIdByRefId(refId);
    if (!found) throw new AppException(ErrorCode.EnterpriseNotFound);

    if (found.status === status) {
      throw new AppException(ErrorCode.InvalidStateTransition, {
        details: [{ field: 'status', issue: `already ${status}` }],
      });
    }
    if (!ENTERPRISE_STATUS_TRANSITIONS[found.status].includes(status)) {
      throw new AppException(ErrorCode.InvalidStateTransition, {
        details: [{ field: 'status', issue: `cannot move from ${found.status} to ${status}` }],
      });
    }

    const applied = await this.platform.updateEnterpriseStatus(found.id, found.status, status);
    if (!applied) {
      // The conditional UPDATE matched nothing, which means another admin moved
      // it between our read and our write. Reporting a conflict is honest; the
      // caller refetches and decides again.
      throw new AppException(ErrorCode.ConcurrentModification);
    }

    await this.audit.record({
      action: AuditAction.Updated,
      entityType: AuditEntityType.Enterprise,
      entityId: found.id,
      enterpriseId: found.id,
      changes: { status: { from: found.status, to: status } },
      metadata: reason ? { reason } : {},
    });

    this.logger.info(
      { enterpriseRefId: refId, from: found.status, to: status },
      'platform admin changed enterprise status',
    );

    return { refId, from: found.status, to: status };
  }

  /**
   * Grants, disables, declines or revokes a feature for a business.
   *
   * Handles the case the business never asked: an admin may switch a feature on
   * for a business that has no row for it at all, which is how a plan gets
   * provisioned. Everything else follows the documented state machine.
   */
  async decideFeature(
    enterpriseRefId: string,
    featureKey: string,
    status: EnterpriseFeatureStatus,
    reason: string | null,
  ): Promise<{
    featureKey: string;
    from: EnterpriseFeatureStatus | null;
    to: EnterpriseFeatureStatus;
  }> {
    const actor = RequestContext.actor();
    const staffId = actor?.staffId;
    if (staffId === undefined || staffId === null) {
      throw new AppException(ErrorCode.PermissionDenied);
    }

    const enterprise = await this.platform.findIdByRefId(enterpriseRefId);
    if (!enterprise) throw new AppException(ErrorCode.EnterpriseNotFound);

    const featureId = await this.platform.findFeatureIdByKey(featureKey);
    if (featureId === null) throw new AppException(ErrorCode.FeatureNotFound);

    const existing = await this.platform.findEnterpriseFeature(enterprise.id, featureId);

    if (!existing) {
      // Nothing to transition FROM. Only granting or declining makes sense as a
      // first act; disabling a feature that was never granted is meaningless.
      if (
        status !== EnterpriseFeatureStatus.Active &&
        status !== EnterpriseFeatureStatus.Declined
      ) {
        throw new AppException(ErrorCode.InvalidStateTransition, {
          details: [{ field: 'status', issue: 'this business has no row for that feature yet' }],
        });
      }

      await this.platform.insertEnterpriseFeature({
        enterpriseId: enterprise.id,
        featureId,
        status,
        decidedByStaffId: staffId,
      });

      await this.audit.record({
        action: AuditAction.FeatureDecided,
        entityType: AuditEntityType.EnterpriseFeature,
        entityId: featureId,
        enterpriseId: enterprise.id,
        changes: { status: { from: null, to: status } },
        metadata: { featureKey, ...(reason ? { reason } : {}) },
      });

      return { featureKey, from: null, to: status };
    }

    if (existing.status === status) {
      throw new AppException(ErrorCode.InvalidStateTransition, {
        details: [{ field: 'status', issue: `already ${status}` }],
      });
    }
    if (!ENTERPRISE_FEATURE_TRANSITIONS[existing.status].includes(status)) {
      throw new AppException(ErrorCode.InvalidStateTransition, {
        details: [{ field: 'status', issue: `cannot move from ${existing.status} to ${status}` }],
      });
    }

    const applied = await this.platform.updateEnterpriseFeatureStatus({
      enterpriseFeatureId: existing.id,
      from: existing.status,
      to: status,
      decidedByStaffId: staffId,
      declineReason: reason,
    });
    if (!applied) throw new AppException(ErrorCode.ConcurrentModification);

    await this.audit.record({
      action: AuditAction.FeatureDecided,
      entityType: AuditEntityType.EnterpriseFeature,
      entityId: featureId,
      enterpriseId: enterprise.id,
      changes: { status: { from: existing.status, to: status } },
      metadata: { featureKey, ...(reason ? { reason } : {}) },
    });

    this.logger.info(
      { enterpriseRefId, featureKey, from: existing.status, to: status },
      'platform admin decided a feature',
    );

    return { featureKey, from: existing.status, to: status };
  }
}

function toListItem(row: {
  refId: string;
  name: string;
  slug: string;
  email: string;
  mobile: string | null;
  status: EnterpriseStatus;
  city: string | null;
  country: string;
  timezone: string;
  createdAt: Date;
  employeeCount: number;
  channelCount: number;
  connectionCount: number;
  customerCount: number;
  conversationCount: number;
  activeFeatureCount: number;
  pendingFeatureCount: number;
}): EnterpriseListItem {
  return {
    refId: row.refId,
    name: row.name,
    slug: row.slug,
    email: row.email,
    mobile: row.mobile,
    status: row.status,
    city: row.city,
    country: row.country,
    timezone: row.timezone,
    createdAt: row.createdAt,
    counts: {
      employees: row.employeeCount,
      channels: row.channelCount,
      connections: row.connectionCount,
      customers: row.customerCount,
      conversations: row.conversationCount,
      activeFeatures: row.activeFeatureCount,
      pendingFeatures: row.pendingFeatureCount,
    },
  };
}

/**
 * The owner's contact details are MASKED even for an admin.
 *
 * An admin needs to recognise the account, not to read the customer's personal
 * data — and this response is the one most likely to end up in a screenshot or a
 * support ticket.
 */
function toOwner(owner: PlatformEnterpriseOwner): EnterpriseDetail['owner'] {
  return {
    name: [owner.firstName, owner.lastName].filter(Boolean).join(' '),
    email: owner.email ? maskEmail(owner.email) : null,
    mobile: owner.mobile ? maskMobile(owner.mobile) : null,
    emailVerified: owner.emailVerifiedAt !== null,
    mobileVerified: owner.mobileVerifiedAt !== null,
    lastLoginAt: owner.lastLoginAt,
  };
}

/**
 * created_at is NOT NULL on enterprises, so a cursor without a timestamp cannot
 * have come from this listing and is treated as absent rather than trusted.
 */
function decodeEnterpriseCursor(cursor: string | null): { createdAt: Date; id: number } | null {
  const parsed = decodeKeysetCursor(cursor);
  return parsed?.at ? { createdAt: parsed.at, id: parsed.id } : null;
}
