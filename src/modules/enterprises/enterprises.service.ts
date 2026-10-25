import { Injectable } from '@nestjs/common';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { AuditService, EntityVersionService } from '@/modules/audit';
import { TransactionManager } from '@/database/transaction/transaction.manager';
import { AuditAction, AuditEntityType } from '@/shared/enums';
import {
  SUPPORTED_CURRENCIES,
  SUPPORTED_TIMEZONES,
  type UpdateBusinessSettingsInput,
} from '@/shared/contracts/enterprises/settings.contract';
import { AppException, ErrorCode } from '@/shared/errors';

/** What a client sees of its own business. No internal ids. */
export interface EnterpriseSummary {
  readonly refId: string;
  readonly name: string;
  readonly slug: string;
  /** NULL = this business has not chosen one yet. */
  readonly timezone: string | null;
  /** NULL = this business has not chosen one yet. */
  readonly currencyCode: string | null;
  readonly status: string;
}

/**
 * Reads of the business a session is scoped to.
 *
 * Separate from EnterpriseOnboardingService, which owns signup and is about
 * CREATING a business. This is about reading the one you are already in, and
 * the two have no steps in common.
 *
 * It exists because the controller was reading the repository itself — the one
 * place the layering was skipped for what looked like a single lookup.
 */
@Injectable()
export class EnterprisesService {
  constructor(
    private readonly enterprises: EnterpriseRepository,
    private readonly audit: AuditService,
    private readonly versions: EntityVersionService,
    private readonly tx: TransactionManager,
  ) {}

  /**
   * Every timezone and currency a business may choose.
   *
   * SERVED RATHER THAN DUPLICATED. The portal renders this as a dropdown, so
   * the set somebody can pick from is literally the set the validator accepts
   * — a hardcoded list in the client would be a second copy, and the first
   * time the runtime's IANA database updated the two would disagree with no
   * symptom until a save failed.
   */
  settingsOptions(): { timezones: readonly string[]; currencies: readonly string[] } {
    return { timezones: SUPPORTED_TIMEZONES, currencies: SUPPORTED_CURRENCIES };
  }

  /**
   * Changes the business's own settings.
   *
   * THE TIMEZONE IS A BUSINESS FACT, and this is the only place it is set.
   * Everything that needs to know what "today" or "6pm" means for a business
   * reads it from here, so changing it moves every cap period and every time
   * window at once. That is the intended behaviour and the reason it is
   * audited AND versioned: "when did Tuesday start meaning something else"
   * has to be answerable, because an award granted last month was decided
   * against the timezone in force last month.
   */
  async updateSettings(
    enterpriseId: number,
    input: UpdateBusinessSettingsInput,
  ): Promise<EnterpriseSummary> {
    const before = await this.enterprises.findById(enterpriseId);
    if (!before) throw new AppException(ErrorCode.EnterpriseNotFound);

    return this.tx.runInTransaction(async () => {
      const updated = await this.enterprises.updateSettings(enterpriseId, input);
      if (!updated) throw new AppException(ErrorCode.EnterpriseNotFound);

      await this.audit.record({
        action: AuditAction.Updated,
        entityType: AuditEntityType.Enterprise,
        entityId: enterpriseId,
        enterpriseId,
        changes: {
          timezone: { from: before.timezone, to: updated.timezone },
          currencyCode: { from: before.currencyCode, to: updated.currencyCode },
        },
      });

      await this.versions.record({
        entityType: AuditEntityType.Enterprise,
        entityId: enterpriseId,
        enterpriseId,
        /* Settings only. Name, slug and email are identity rather than
         * preference and are not editable here, so they are not snapshotted
         * here either — a snapshot should describe what this surface controls. */
        snapshot: { timezone: updated.timezone, currencyCode: updated.currencyCode },
      });

      return {
        refId: updated.refId,
        name: updated.name,
        slug: updated.slug,
        timezone: updated.timezone,
        currencyCode: updated.currencyCode,
        status: updated.status,
      };
    });
  }

  /**
   * READ, not taken from the token. The business may have been activated or
   * suspended since the token was issued, and a client rendering a stale status
   * looks broken in a way nobody can explain.
   */
  async current(enterpriseId: number): Promise<EnterpriseSummary> {
    const enterprise = await this.enterprises.findById(enterpriseId);
    if (!enterprise) throw new AppException(ErrorCode.EnterpriseNotFound);

    return {
      refId: enterprise.refId,
      name: enterprise.name,
      slug: enterprise.slug,
      timezone: enterprise.timezone,
      currencyCode: enterprise.currencyCode,
      status: enterprise.status,
    };
  }
}
