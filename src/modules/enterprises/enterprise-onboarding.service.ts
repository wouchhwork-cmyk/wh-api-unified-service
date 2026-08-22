import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnterpriseEmployeeRepository } from '@/database/repositories/enterprise-employee.repository';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { IdentityRepository } from '@/database/repositories/identity.repository';
import { RoleRepository } from '@/database/repositories/role.repository';
import { TransactionManager } from '@/database/transaction';
import { SecretHashService } from '@/shared/crypto';
import {
  DeliveryChannel,
  EnterpriseStatus,
  EmployeeKind,
  EmployeeStatus,
  VerificationKind,
  VerificationSubjectKind,
} from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import {
  isValidEmail,
  normalizeEmail,
  normalizeMobile,
  normalizeOptionalText,
  normalizeSlug,
  normalizeText,
  normalizeUrl,
  type NormalizedMobile,
} from '@/shared/utils/normalize';
import type { SignupRequest, SignupResponse } from '@/shared/contracts/enterprises/signup.contract';
import { VerificationService, type PendingOtpDelivery } from '../auth/verification.service';

interface NormalizedOwner {
  readonly firstName: string;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly mobile: NormalizedMobile | null;
  readonly password: string;
}

@Injectable()
export class EnterpriseOnboardingService {
  constructor(
    private readonly enterprises: EnterpriseRepository,
    private readonly identities: IdentityRepository,
    private readonly employees: EnterpriseEmployeeRepository,
    private readonly roles: RoleRepository,
    private readonly hasher: SecretHashService,
    private readonly verifications: VerificationService,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(EnterpriseOnboardingService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Business onboarding (schema.md §11 signup flow).
   *
   * One transaction creates the enterprise, the owner's identity, the employment,
   * and the enterprise's own copies of the system role templates — then grants
   * the owner role. All of it, or none: a business whose founder has no role is
   * an account nobody can administer.
   *
   * NO SESSION IS ISSUED. Signup always ends in a verification challenge, so an
   * unverified address can never hold a session.
   */
  async signup(
    request: SignupRequest,
    meta: { ipAddress: string | null; userAgent: string | null },
  ): Promise<{ response: SignupResponse; pendingDelivery: PendingOtpDelivery }> {
    const owner = this.normalizeOwner(request.owner);
    const business = this.normalizeBusiness(request.business);

    // Reads and validation happen BEFORE the transaction opens, so it stays short.
    const slug = request.business.slug
      ? normalizeSlug(request.business.slug)
      : await this.enterprises.findAvailableSlug(normalizeSlug(request.business.name));

    const created = await this.tx.runInTransaction(async () => {
      const enterprise = await this.enterprises.create({
        ...business,
        slug,
        // A signup does not switch a business on. Somebody at Wouchh activates
        // it, which is what makes onboarding a decision rather than a side
        // effect of a form submission.
        status: EnterpriseStatus.PendingActivation,
      });

      const identity = await this.identities.create({
        email: owner.email,
        mobile: owner.mobile?.canonical ?? null,
        mobileCountryCode: owner.mobile?.countryCode ?? null,
        mobileCallingCode: owner.mobile?.callingCode ?? null,
        mobileNationalNumber: owner.mobile?.nationalNumber ?? null,
        passwordHash: await this.hasher.hashPassword(owner.password),
        firstName: owner.firstName,
        lastName: owner.lastName,
      });

      const employee = await this.employees.create({
        identityId: identity.id,
        enterpriseId: enterprise.id,
        employeeKind: EmployeeKind.Business,
        // Active immediately: this person just proved they control the
        // credential by choosing the password, and the verification below gates
        // the session rather than the employment.
        status: EmployeeStatus.Active,
      });

      // Copies the NULL-enterprise templates into this enterprise. Required,
      // not cosmetic: employee_roles' composite foreign keys make a
      // NULL-enterprise role structurally unassignable (schema.md §8).
      const roleIds = await this.roles.instantiateSystemRoles(enterprise.id);
      await this.roles.grantOwner(enterprise.id, employee.id, roleIds);

      return { enterprise, identity, employee };
    });

    // Outside the transaction: issuing a verification writes its own rows and
    // enqueues a send, and holding the signup transaction open across that would
    // widen it for no benefit.
    const destination = owner.email ?? owner.mobile?.canonical;
    if (!destination) throw new AppException(ErrorCode.CredentialRequired);

    const issued = await this.verifications.issue({
      subjectKind: VerificationSubjectKind.Identity,
      identityId: created.identity.id,
      customerId: null,
      customerIdentifierId: null,
      enterpriseId: created.enterprise.id,
      verificationKind: VerificationKind.FirstLogin,
      destination,
      deliveryChannel: owner.email ? DeliveryChannel.Email : DeliveryChannel.Sms,
      requestedIp: meta.ipAddress,
      requestedUserAgent: meta.userAgent,
    });

    this.logger.info({ enterpriseId: created.enterprise.id, slug }, 'enterprise onboarded');

    return {
      response: {
        enterpriseRefId: created.enterprise.refId,
        slug: created.enterprise.slug,
        identityRefId: created.identity.refId,
        employeeRefId: created.employee.refId,
        verificationRefId: issued.verificationRefId,
        maskedDestination: issued.maskedDestination,
      },
      pendingDelivery: issued.delivery,
    };
  }

  /**
   * Normalization happens ONCE, here at the service boundary, before anything
   * reaches a repository — never at read time and never in two places.
   */
  private normalizeOwner(owner: SignupRequest['owner']): NormalizedOwner {
    const email = owner.email === undefined ? null : normalizeEmail(owner.email);
    if (email !== null && !isValidEmail(email)) {
      throw new AppException(ErrorCode.InvalidEmail, {
        details: [{ field: 'owner.email', issue: 'unparseable' }],
      });
    }

    let mobile: NormalizedMobile | null = null;
    if (owner.mobile !== undefined) {
      mobile = normalizeMobile(owner.mobile);
      if (mobile === null) {
        throw new AppException(ErrorCode.InvalidMobile, {
          details: [{ field: 'owner.mobile', issue: 'not valid for the country given' }],
        });
      }
    }

    // Mirrors the identities CHECK constraint. Rejecting here gives a clean
    // 422 instead of a constraint violation surfacing as a 409.
    if (email === null && mobile === null) {
      throw new AppException(ErrorCode.CredentialRequired);
    }

    return {
      firstName: normalizeText(owner.firstName),
      lastName: normalizeOptionalText(owner.lastName),
      email,
      mobile,
      password: owner.password,
    };
  }

  private normalizeBusiness(business: SignupRequest['business']) {
    const email = normalizeEmail(business.email);
    if (!isValidEmail(email)) {
      throw new AppException(ErrorCode.InvalidEmail, {
        details: [{ field: 'business.email', issue: 'unparseable' }],
      });
    }

    let mobile: NormalizedMobile | null = null;
    if (business.mobile !== undefined) {
      mobile = normalizeMobile(business.mobile);
      if (mobile === null) {
        throw new AppException(ErrorCode.InvalidMobile, {
          details: [{ field: 'business.mobile', issue: 'not valid for the country given' }],
        });
      }
    }

    return {
      name: normalizeText(business.name),
      email,
      mobile: mobile?.canonical ?? null,
      mobileCountryCode: mobile?.countryCode ?? null,
      mobileCallingCode: mobile?.callingCode ?? null,
      mobileNationalNumber: mobile?.nationalNumber ?? null,
      country: business.country.toUpperCase(),
      timezone: business.timezone,
      websiteUrl: business.websiteUrl === undefined ? null : normalizeUrl(business.websiteUrl),
      city: normalizeOptionalText(business.city),
      state: normalizeOptionalText(business.state),
    };
  }
}
