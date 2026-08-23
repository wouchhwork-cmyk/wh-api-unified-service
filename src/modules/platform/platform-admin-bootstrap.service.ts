import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { IdentityRepository } from '@/database/repositories/identity.repository';
import { StaffMemberRepository } from '@/database/repositories/staff-member.repository';
import { TransactionManager } from '@/database/transaction';
import { SecretHashService } from '@/shared/crypto';
import { StaffStatus } from '@/shared/enums';
import { maskEmail, maskMobile, normalizeEmail, normalizeMobile } from '@/shared/utils/normalize';

/**
 * Creates the one internal login that can see the whole platform.
 *
 * Internal staff have no signup route, by design — a self-service path to a
 * staff account would be the single worst hole in the product — so the first one
 * has to come from configuration. It runs on every boot and is idempotent:
 * present and correct is a no-op.
 *
 * The configured credential is treated as the SOURCE OF TRUTH for this one
 * account. Change the env and restart, and the password changes. That is the
 * least surprising behaviour for something provisioned by config, and it is also
 * the recovery path when the password is lost.
 */
@Injectable()
export class PlatformAdminBootstrapService implements OnApplicationBootstrap {
  constructor(
    private readonly config: AppConfigService,
    private readonly identities: IdentityRepository,
    private readonly staff: StaffMemberRepository,
    private readonly hasher: SecretHashService,
    private readonly tx: TransactionManager,
    @InjectPinoLogger(PlatformAdminBootstrapService.name) private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const admin = this.config.platformAdmin;
    if (!admin.enabled) {
      this.logger.debug('platform admin bootstrap is disabled');
      return;
    }

    const email = admin.email ? normalizeEmail(admin.email) : null;
    const mobile = admin.mobile
      ? normalizeMobile({ number: admin.mobile, countryCode: 'IN' })
      : null;

    if (!email && !mobile) {
      // Loud but not fatal: refusing to boot over a provisioning convenience
      // would take the whole service down for a misconfigured optional feature.
      this.logger.error(
        'PLATFORM_ADMIN_ENABLED is true but neither email nor mobile could be normalized',
      );
      return;
    }

    try {
      await this.tx.runInTransaction(async () => {
        const existing =
          (email ? await this.identities.findByEmail(email) : null) ??
          (mobile ? await this.identities.findByMobile(mobile.canonical) : null);

        const identityId = existing
          ? await this.reconcileIdentity(existing.id, existing.passwordHash, admin.password)
          : await this.createIdentity(admin, email, mobile);

        await this.ensureStaffRow(identityId);
      });

      this.logger.warn(
        {
          // Masked, like the mobile beside it. This line named the
          // platform-admin address in clear on every boot — the single
          // highest-value login in the system, written to whatever ships the
          // logs, and PII besides.
          email: email ? maskEmail(email) : null,
          mobile: mobile ? maskMobile(mobile.canonical) : null,
          realtimeOtp: this.config.otp.realtimeEnabled,
        },
        'platform admin is provisioned from configuration',
      );
    } catch (error) {
      // Provisioning failing must not stop the service: every other flow still
      // works, and the operator needs the logs to be reachable to diagnose it.
      this.logger.error({ err: error }, 'platform admin bootstrap failed');
    }
  }

  /**
   * Leaves an existing admin's password ALONE.
   *
   * It used to re-apply the configured value on every boot whenever the two
   * differed, which made the credential self-healing: an operator who changed
   * the platform admin's password found the old one working again after the next
   * restart. Combined with a password that is in this repository's history, that
   * is a known credential nobody can revoke by changing it.
   *
   * Provisioning is create-if-absent now. A deliberate recovery — the password
   * genuinely lost — is still possible, but it has to be asked for explicitly
   * through PLATFORM_ADMIN_FORCE_PASSWORD_RESET, and it says so loudly.
   */
  private async reconcileIdentity(
    identityId: number,
    currentHash: string,
    configuredPassword: string,
  ): Promise<number> {
    if (!this.config.platformAdmin.forcePasswordReset) {
      this.logger.info(
        { identityId },
        'platform admin already exists — its password is left as it is',
      );
      return identityId;
    }

    const matches = await this.hasher.verifyPassword(currentHash, configuredPassword);
    if (!matches) {
      await this.identities.updatePasswordHash(
        identityId,
        await this.hasher.hashPassword(configuredPassword),
      );
      this.logger.warn(
        { identityId },
        'PLATFORM_ADMIN_FORCE_PASSWORD_RESET is on and overwrote the admin password from configuration — turn it back off',
      );
    }
    return identityId;
  }

  private async createIdentity(
    admin: { name: string; password: string },
    email: string | null,
    mobile: {
      canonical: string;
      countryCode: string;
      callingCode: string;
      nationalNumber: string;
    } | null,
  ): Promise<number> {
    const [firstName, ...rest] = admin.name.trim().split(/\s+/);

    const identity = await this.identities.create({
      email,
      mobile: mobile?.canonical ?? null,
      mobileCountryCode: mobile?.countryCode ?? null,
      mobileCallingCode: mobile?.callingCode ?? null,
      mobileNationalNumber: mobile?.nationalNumber ?? null,
      passwordHash: await this.hasher.hashPassword(admin.password),
      firstName: firstName ?? 'Platform',
      lastName: rest.length > 0 ? rest.join(' ') : null,
    });

    /*
     * Marked verified without a code, on purpose.
     *
     * Verification proves control of an address the person typed in. Nobody
     * typed this one — an operator put it in the deployment configuration, which
     * is a stronger claim than any OTP. Leaving it unverified would instead send
     * a code to an address that may not be able to receive one, and lock the
     * account out of its own first login.
     */
    if (email) await this.identities.markCredentialVerified(identity.id, 'email');
    if (mobile) await this.identities.markCredentialVerified(identity.id, 'mobile');

    return identity.id;
  }

  private async ensureStaffRow(identityId: number): Promise<void> {
    const existing = await this.staff.findAnyByIdentity(identityId);

    if (!existing) {
      await this.staff.create({ identityId, hasAllEnterpriseAccess: true });
      return;
    }

    // A suspended or downgraded row is brought back: the configuration says this
    // account is a platform admin, so on boot it is one.
    if (existing.status !== StaffStatus.Active || !existing.hasAllEnterpriseAccess) {
      await this.staff.activateWithFullAccess(existing.staffId);
      this.logger.warn({ staffId: existing.staffId }, 'platform admin staff row reactivated');
    }
  }
}
