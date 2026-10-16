import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  EnterpriseFeatureRepository,
  type EnterpriseFeatureRow,
} from '@/database/repositories/enterprise-feature.repository';
import { AuditService } from '@/modules/audit';
import {
  AuditAction,
  AuditEntityType,
  ENTERPRISE_FEATURE_TRANSITIONS,
  EnterpriseFeatureStatus,
} from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';

/** One feature, as the business sees its own standing on it. */
export interface EnterpriseFeatureView {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  /** NULL means never requested, which reads the same as not enabled. */
  readonly status: EnterpriseFeatureStatus | null;
  readonly active: boolean;
  /** Whether this business may ask for it from where it currently stands. */
  readonly requestable: boolean;
  readonly enabledAt: Date | null;
  readonly expiresAt: Date | null;
  readonly declineReason: string | null;
}

/**
 * The business's own side of the feature model.
 *
 * Read-only apart from asking. Granting stays a platform decision — a business
 * that could grant itself a feature is not a feature model, it is a settings
 * screen — so this service can only ever move something INTO
 * `access_requested`.
 */
@Injectable()
export class FeaturesService {
  constructor(
    private readonly features: EnterpriseFeatureRepository,
    private readonly audit: AuditService,
    @InjectPinoLogger(FeaturesService.name) private readonly logger: PinoLogger,
  ) {}

  async listForEnterprise(enterpriseId: number): Promise<readonly EnterpriseFeatureView[]> {
    const rows = await this.features.listForEnterprise(enterpriseId);
    return rows.map((row) => this.toView(row));
  }

  async request(
    enterpriseId: number,
    requestedByEmployeeId: number,
    featureKey: string,
  ): Promise<void> {
    const before = await this.features.currentStatus(enterpriseId, featureKey);

    /*
     * Refused BEFORE the write, from the same transition map the platform side
     * uses, so a business is told why rather than meeting a silent no-op.
     *
     * Already pending is not an error — a double-click on "request access"
     * should not read as a failure — so it returns quietly. Everything else
     * that cannot reach `access_requested` is a real refusal.
     */
    if (before === EnterpriseFeatureStatus.AccessRequested) return;
    if (before !== null && !this.mayRequestFrom(before)) {
      throw new AppException(ErrorCode.InvalidStateTransition, {
        details: [
          {
            field: 'featureKey',
            issue:
              before === EnterpriseFeatureStatus.Revoked
                ? 'this feature was withdrawn and cannot be requested again here'
                : `cannot request a feature that is ${before}`,
          },
        ],
      });
    }

    const result = await this.features.requestAccess({
      enterpriseId,
      featureKey,
      requestedByEmployeeId,
    });
    // Nothing came back: the key is unknown or deprecated. The row-level check
    // above cannot see that, because a business with no row looks identical.
    if (!result) throw new AppException(ErrorCode.FeatureNotFound);

    await this.audit.record({
      action: AuditAction.FeatureRequested,
      entityType: AuditEntityType.EnterpriseFeature,
      entityId: null,
      enterpriseId,
      metadata: { feature: featureKey, from: before },
    });
    this.logger.info({ enterpriseId, feature: featureKey }, 'feature access requested');
  }

  /**
   * Whether `access_requested` is reachable from where this business stands.
   *
   * Read off ENTERPRISE_FEATURE_TRANSITIONS rather than restated, so the two
   * sides of the model cannot drift — the platform side already reads the same
   * map, and a second hand-written list is how `revoked` would eventually
   * become self-serve by accident.
   */
  private mayRequestFrom(status: EnterpriseFeatureStatus): boolean {
    return ENTERPRISE_FEATURE_TRANSITIONS[status].includes(EnterpriseFeatureStatus.AccessRequested);
  }

  private toView(row: EnterpriseFeatureRow): EnterpriseFeatureView {
    return {
      key: row.key,
      name: row.name,
      description: row.description,
      status: row.status,
      active: row.status === EnterpriseFeatureStatus.Active,
      requestable:
        row.status === null
          ? true
          : row.status !== EnterpriseFeatureStatus.AccessRequested &&
            this.mayRequestFrom(row.status),
      enabledAt: row.enabledAt,
      expiresAt: row.expiresAt,
      declineReason: row.declineReason,
    };
  }
}
