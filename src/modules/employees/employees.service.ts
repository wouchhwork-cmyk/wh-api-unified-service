import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnterpriseEmployeeRepository } from '@/database/repositories/enterprise-employee.repository';
import type { EmployeeListRow } from '@/database/repositories/enterprise-employee.repository';
import { IdentityRepository } from '@/database/repositories/identity.repository';
import { RoleRepository } from '@/database/repositories/role.repository';
import { SessionRepository } from '@/database/repositories/session.repository';
import { TransactionManager } from '@/database/transaction';
import { AuditService } from '@/modules/audit';
import { VerificationService, type PendingOtpDelivery } from '@/modules/auth/verification.service';
import { SecretHashService } from '@/shared/crypto';
import { ROLE_LEVEL } from '@/shared/enums';
import {
  explainDenial,
  mayAssignRole,
  mayModifyEmployee,
  type ActorAuthority,
} from '@/shared/rbac';
import {
  AuditAction,
  AuditEntityType,
  DeliveryChannel,
  EmployeeKind,
  EmployeeStatus,
  VerificationKind,
  VerificationSecretShape,
  VerificationSubjectKind,
} from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import type { CreateEmployeeRequest } from '@/shared/contracts/employees/employee.contract';
import type { EmployeeDto } from '@/shared/contracts/employees/employee.contract';
import { maskEmail, maskMobile, normalizeEmail, normalizeMobile } from '@/shared/utils/normalize';
import { decodeKeysetCursor, encodeKeysetCursor } from '@/shared/utils/keyset-cursor';
import { clampLimit } from '@/shared/utils/page-limit';

export interface CreatedEmployee {
  readonly employee: EmployeeDto;
  /** The invite, handed to the delivery path by the controller. */
  readonly pendingDelivery: PendingOtpDelivery;
}

/**
 * Who works at a business, and how they come to.
 *
 * THERE IS NO SIGNUP FOR AN EMPLOYEE, and that is the whole design. Signup
 * creates a business and exactly one person: its owner. Everybody after that is
 * created here, by somebody already inside who holds `employees.invite`. Two
 * consequences fall out of it, both wanted: one business cannot be signed up
 * twice, and nobody can add themselves to a business they do not belong to.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly employees: EnterpriseEmployeeRepository,
    private readonly identities: IdentityRepository,
    private readonly roles: RoleRepository,
    private readonly verifications: VerificationService,
    private readonly hasher: SecretHashService,
    private readonly audit: AuditService,
    private readonly sessions: SessionRepository,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(EmployeesService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * One page of the people who work here.
   *
   * It used to be every one of them, unbounded. A business with a few hundred
   * staff — which is the kind of business this product is sold to — turned one
   * screen into an unbounded read, and the endpoint had no way to say "there is
   * more".
   */
  async list(
    enterpriseId: number,
    /** NULL for a Wouchh staff actor reaching into this business. */
    actingEmployeeId: number | null,
    includeSupport: boolean,
    query: { limit: number | null; cursor: string | null },
  ): Promise<{
    items: EmployeeDto[];
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const limit = clampLimit(query.limit);

    /*
     * WHAT YOU MAY SEE FOLLOWS WHAT YOU OUTRANK. An agent sees agents and the
     * people below them, never the managers above.
     *
     * Somebody holding no roles sees nobody — not an empty-list bug but the
     * honest answer, since they outrank nothing. Their own record still reaches
     * them through /auth/me, which is not a listing.
     */
    /*
     * STAFF ARE NOT ON THIS LADDER, and must not be silently dropped off it.
     *
     * A Wouchh staff actor has no employment in the business, so they have no
     * role and no level — and treating that as "outranks nobody" would show
     * support an empty team and look like a bug rather than a rule. Their
     * authority is governed on the platform side: reaching into a tenant at all
     * already requires has_all_enterprise_access and is audited as
     * impersonation. So they see the whole team, which is what they saw before
     * this filter existed.
     */
    const viewerLevel =
      actingEmployeeId === null
        ? ROLE_LEVEL.Owner
        : await this.roles.highestLevelForEmployee(enterpriseId, actingEmployeeId);

    if (viewerLevel === null) {
      return { items: [], limit, nextCursor: null, hasMore: false };
    }

    const rows = await this.employees.listForEnterprise(enterpriseId, {
      includeSupport,
      // One extra row answers "is there another page" without a second COUNT
      // over the same predicate.
      limit: limit + 1,
      cursor: decodeEmployeeCursor(query.cursor),
      viewerLevel,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(toDto),
      limit,
      nextCursor: hasMore && last ? encodeKeysetCursor(last.createdAt, last.internalId) : null,
      hasMore,
    };
  }

  /**
   * The roles this business can assign.
   *
   * Its OWN copies of the templates, made at signup — which is why this is
   * scoped rather than a catalogue read.
   */
  async listRoleOptions(enterpriseId: number): Promise<{ refId: string; name: string }[]> {
    const roles = await this.roles.listForEnterprise(enterpriseId);
    return roles.map((role) => ({ refId: role.refId, name: role.name }));
  }

  /**
   * Creates a colleague and the invitation that lets them set a password.
   *
   * The identity is created with a RANDOM password nobody is ever told. It exists
   * only because the column is NOT NULL, and it is unusable by construction: the
   * only way in is the invite, which proves control of the address on the way
   * through. An owner-chosen temporary password would be simpler and worse — the
   * owner would know a credential that can act as their colleague, and every
   * message that colleague sends would have two people who could have sent it.
   */
  /**
   * What the acting employee is allowed to do, in one round trip.
   *
   * Fetched per request rather than carried on the token: a role changed a
   * moment ago must take effect on the next action, exactly as the permission
   * set already does. Putting the level in the JWT would make a demotion wait
   * for the token to expire.
   */
  private async authorityOf(enterpriseId: number, employeeId: number): Promise<ActorAuthority> {
    const authority = await this.roles.authorityOfEmployee(enterpriseId, employeeId);
    return {
      employeeId,
      level: authority.level,
      roleNames: authority.roleNames,
      permissionCodes: new Set(authority.permissionCodes),
    };
  }

  async create(
    enterpriseId: number,
    actingEmployeeId: number,
    request: CreateEmployeeRequest,
  ): Promise<CreatedEmployee> {
    const email = request.email === undefined ? null : normalizeEmail(request.email);
    const mobile = request.mobile === undefined ? null : normalizeMobile(request.mobile);
    if (request.mobile !== undefined && mobile === null) {
      throw new AppException(ErrorCode.InvalidMobile);
    }
    if (!email && !mobile) throw new AppException(ErrorCode.CredentialRequired);

    const role = await this.roles.findByRefId(enterpriseId, request.roleRefId);
    if (!role) throw new AppException(ErrorCode.RoleNotFound);

    /*
     * NOBODY GRANTS ABOVE THEMSELVES.
     *
     * `employees.invite` says who may invite, not what they may hand out — so
     * without this an actor holding it could name any role in the body, invite
     * an address they control, accept the invite and come back holding it.
     *
     * This used to be one string comparison against the name `owner`, which
     * covered the worst case and nothing else: a manager could still mint
     * another manager. It is now a level comparison, so the rule is "strictly
     * below you" for every role rather than "not the top one".
     */
    const denial = mayAssignRole(await this.authorityOf(enterpriseId, actingEmployeeId), role);
    if (denial) {
      throw new AppException(ErrorCode.PermissionDenied, {
        details: [{ field: 'roleRefId', issue: explainDenial(denial) }],
      });
    }

    /*
     * HASHED BEFORE THE TRANSACTION OPENS.
     *
     * argon2id is deliberately expensive, and inside the transaction that cost
     * was paid while holding locks. It is computed unconditionally — the
     * identity may turn out to already exist and the value go unused — because
     * one wasted hash on a rare path is cheaper than a held lock on every path.
     *
     * A token shape, not a numeric code: nobody ever types this, so length beats
     * memorability, and OTP_STATIC_CODE must never reach it.
     */
    const placeholderPasswordHash = await this.hasher.hashPassword(
      this.hasher.generateSecret(VerificationSecretShape.Token, 32),
    );

    const created = await this.tx.runInTransaction(async () => {
      /*
       * An identity is global: this person may already have a login because they
       * work for another business on the platform. Reuse it rather than refusing
       * — one human, one password, however many jobs.
       */
      const existing =
        (email ? await this.identities.findByEmail(email) : null) ??
        (mobile ? await this.identities.findByMobile(mobile.canonical) : null);

      if (existing) {
        const already = await this.employees.findByIdentity(enterpriseId, existing.id);
        if (already) throw new AppException(ErrorCode.EmployeeAlreadyExists);
      }

      const identity =
        existing ??
        (await this.identities.create({
          email,
          mobile: mobile?.canonical ?? null,
          mobileCountryCode: mobile?.countryCode ?? null,
          mobileCallingCode: mobile?.callingCode ?? null,
          mobileNationalNumber: mobile?.nationalNumber ?? null,
          // Random, never revealed, and never usable: the invite is the only
          // way in, and completing it replaces this.
          passwordHash: placeholderPasswordHash,
          firstName: request.firstName,
          lastName: request.lastName ?? null,
        }));

      const employee = await this.employees.create({
        identityId: identity.id,
        enterpriseId,
        employeeKind: EmployeeKind.Business,
        // Invited, not active: they have not proven the address yet, and an
        // account that can act before that is an account somebody else can take.
        status: EmployeeStatus.Invited,
        invitedByEmployeeId: actingEmployeeId,
      });

      await this.roles.grantToEmployee({
        enterpriseId,
        employeeId: employee.id,
        roleId: role.id,
        grantedByEmployeeId: actingEmployeeId,
      });

      return { identity, employee, reusedIdentity: existing !== null };
    });

    // Outside the transaction: issuing a verification writes its own rows, and
    // holding the creation open across it would widen it for no benefit.
    const destination = email ?? mobile?.canonical;
    if (!destination) throw new AppException(ErrorCode.CredentialRequired);

    const issued = await this.verifications.issue({
      subjectKind: VerificationSubjectKind.Identity,
      identityId: created.identity.id,
      customerId: null,
      customerIdentifierId: null,
      enterpriseId,
      verificationKind: VerificationKind.EmployeeInvite,
      destination,
      deliveryChannel: email ? DeliveryChannel.Email : DeliveryChannel.Sms,
      requestedIp: null,
      requestedUserAgent: null,
    });

    await this.audit.record({
      action: AuditAction.Created,
      entityType: AuditEntityType.EnterpriseEmployee,
      entityId: created.employee.id,
      enterpriseId,
      changes: { status: { from: null, to: EmployeeStatus.Invited } },
      metadata: { role: role.name, reusedExistingLogin: created.reusedIdentity },
    });

    this.logger.info(
      { enterpriseId, role: role.name, reusedIdentity: created.reusedIdentity },
      'employee created and invited',
    );

    return {
      employee: {
        refId: created.employee.refId,
        name: [request.firstName, request.lastName].filter(Boolean).join(' '),
        email: email ? maskEmail(email) : null,
        mobile: mobile ? maskMobile(mobile.canonical) : null,
        emailVerified: false,
        mobileVerified: false,
        employeeKind: EmployeeKind.Business,
        status: EmployeeStatus.Invited,
        roles: [role.name],
        // The role was just resolved, so the level is known without a query.
        roleLevel: role.level,
        invitedAt: new Date(),
        joinedAt: null,
        lastActiveAt: null,
        lastLoginAt: null,
      },
      pendingDelivery: issued.delivery,
    };
  }

  /**
   * Suspends or reinstates somebody.
   *
   * Suspending does NOT delete: the record of what they did has to survive them
   * leaving, so this is a status change and nothing else.
   */
  async setStatus(
    enterpriseId: number,
    actingEmployeeId: number,
    refId: string,
    status: EmployeeStatus,
    reason: string | null,
  ): Promise<{ refId: string; from: EmployeeStatus; to: EmployeeStatus }> {
    const employee = await this.employees.findAnyByRefId(enterpriseId, refId);
    if (!employee) throw new AppException(ErrorCode.EmployeeNotFound);

    /*
     * Nobody suspends themselves out of their own business, and nobody suspends
     * somebody at or above their own level.
     *
     * The second half is new and was a real hole: `employees.manage` is held by
     * the manager role, and the only check here was the self one — so a manager
     * could suspend the owner, which revokes every session that identity holds
     * across every business. Two managers could also suspend each other, which
     * turns a disagreement into a race.
     */
    const modifyDenial = mayModifyEmployee(
      await this.authorityOf(enterpriseId, actingEmployeeId),
      {
        employeeId: employee.employeeId,
        level: await this.roles.highestLevelForEmployee(enterpriseId, employee.employeeId),
      },
    );
    if (modifyDenial) {
      throw new AppException(ErrorCode.PermissionDenied, {
        details: [{ field: 'refId', issue: explainDenial(modifyDenial) }],
      });
    }

    if (employee.status === status) {
      throw new AppException(ErrorCode.InvalidStateTransition, {
        details: [{ field: 'status', issue: `already ${status}` }],
      });
    }

    const applied = await this.employees.setStatus(
      enterpriseId,
      employee.employeeId,
      employee.status,
      status,
    );
    if (!applied) throw new AppException(ErrorCode.ConcurrentModification);

    /*
     * SUSPENDING SOMEBODY SIGNS THEM OUT.
     *
     * It did not. revokeAllForIdentity existed with no callers anywhere, and
     * AuthService.refresh only re-checks employment when the caller passes
     * ?enterpriseRefId — so a suspended person kept refreshing indefinitely and
     * their access token stayed valid for its full life. "Suspended" meant
     * "cannot sign in again", not "is signed out", which is not what anybody
     * pressing that button believes.
     *
     * The identity is global, so this ends every session — including ones for
     * OTHER businesses this person works for. That is the deliberate choice:
     * over-revoking costs a colleague one sign-in, and under-revoking leaves a
     * suspended account working.
     */
    if (status === EmployeeStatus.Suspended) {
      const revoked = await this.sessions.revokeAllForIdentity(employee.identityId);
      this.logger.info(
        { enterpriseId, employeeId: employee.employeeId, revoked },
        'employee suspended — every session for that identity was revoked',
      );
    }

    await this.audit.record({
      action: AuditAction.Updated,
      entityType: AuditEntityType.EnterpriseEmployee,
      entityId: employee.employeeId,
      enterpriseId,
      changes: { status: { from: employee.status, to: status } },
      metadata: reason ? { reason } : {},
    });

    return { refId, from: employee.status, to: status };
  }
}

/**
 * created_at is NOT NULL on enterprise_employees, so a cursor without a
 * timestamp cannot have come from this listing and is treated as absent rather
 * than trusted — the caller gets the first page, not an error.
 */
function decodeEmployeeCursor(cursor: string | null): { createdAt: Date; id: number } | null {
  const parsed = decodeKeysetCursor(cursor);
  return parsed?.at ? { createdAt: parsed.at, id: parsed.id } : null;
}

function toDto(row: EmployeeListRow): EmployeeDto {
  return {
    refId: row.refId,
    name: [row.firstName, row.lastName].filter(Boolean).join(' '),
    // Masked even for a colleague: a list screen is the most screenshotted thing
    // in any admin surface.
    email: row.email ? maskEmail(row.email) : null,
    mobile: row.mobile ? maskMobile(row.mobile) : null,
    emailVerified: row.emailVerified,
    mobileVerified: row.mobileVerified,
    employeeKind: row.employeeKind,
    status: row.status,
    roles: row.roles,
    roleLevel: row.roleLevel,
    invitedAt: row.invitedAt,
    joinedAt: row.joinedAt,
    lastActiveAt: row.lastActiveAt,
    lastLoginAt: row.lastLoginAt,
  };
}
