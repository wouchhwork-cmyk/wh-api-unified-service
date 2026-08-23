import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnterpriseEmployeeRepository } from '@/database/repositories/enterprise-employee.repository';
import type { EmployeeListRow } from '@/database/repositories/enterprise-employee.repository';
import { IdentityRepository } from '@/database/repositories/identity.repository';
import { RoleRepository } from '@/database/repositories/role.repository';
import { TransactionManager } from '@/database/transaction';
import { AuditService } from '@/modules/audit';
import { VerificationService, type PendingOtpDelivery } from '@/modules/auth/verification.service';
import { SecretHashService } from '@/shared/crypto';
import {
  AuditAction,
  AuditEntityType,
  DeliveryChannel,
  EmployeeKind,
  EmployeeStatus,
  SystemRole,
  VerificationKind,
  VerificationSecretShape,
  VerificationSubjectKind,
} from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import type { CreateEmployeeRequest } from '@/shared/contracts/employees/employee.contract';
import type { EmployeeDto } from '@/shared/contracts/employees/employee.contract';
import { maskEmail, maskMobile, normalizeEmail, normalizeMobile } from '@/shared/utils/normalize';

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
    private readonly tx: TransactionManager,
    @InjectPinoLogger(EmployeesService.name) private readonly logger: PinoLogger,
  ) {}

  async list(enterpriseId: number, includeSupport: boolean): Promise<EmployeeDto[]> {
    const rows = await this.employees.listForEnterprise(enterpriseId, { includeSupport });
    return rows.map(toDto);
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
     * employees.invite is held by the manager role, and without this check the
     * body could name the OWNER role — so a manager could invite an address they
     * control, accept the invite, and hold full control of the business,
     * including billing and the ability to remove the real owner. The permission
     * that guards the endpoint cannot express this: it says who may invite, not
     * what they may hand out.
     *
     * Checked against the roles the actor actually holds rather than against a
     * permission, because "can grant owner" is not a permission the catalogue
     * has — owner is the top of the ladder by definition.
     */
    if (role.name === (SystemRole.Owner as string)) {
      const actorRoles = await this.roles.listRoleNamesForEmployee(enterpriseId, actingEmployeeId);
      if (!actorRoles.includes(SystemRole.Owner)) {
        throw new AppException(ErrorCode.PermissionDenied);
      }
    }

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
          // A token shape, not a numeric code: nobody types this, so length
          // beats memorability — and OTP_STATIC_CODE must never reach it.
          passwordHash: await this.hasher.hashPassword(
            this.hasher.generateSecret(VerificationSecretShape.Token, 32),
          ),
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

    // Nobody suspends themselves out of their own business. The realistic case is
    // an owner locking themselves out with no second admin to undo it.
    if (employee.employeeId === actingEmployeeId) {
      throw new AppException(ErrorCode.PermissionDenied, {
        details: [{ field: 'refId', issue: 'you cannot change your own status' }],
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
    invitedAt: row.invitedAt,
    joinedAt: row.joinedAt,
    lastActiveAt: row.lastActiveAt,
    lastLoginAt: row.lastLoginAt,
  };
}
