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
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/shared/constants';
import { RequestContext } from '@/shared/context';
import {
  AuditAction,
  AuditEntityType,
  ENTERPRISE_FEATURE_TRANSITIONS,
  ENTERPRISE_STATUS_TRANSITIONS,
  EnterpriseFeatureStatus,
  EnterpriseStatus,
} from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';
import { maskEmail, maskMobile } from '@/shared/utils/normalize';

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
    private readonly audit: AuditService,
    @InjectPinoLogger(PlatformService.name) private readonly logger: PinoLogger,
  ) {}

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
      cursor: decodeCursor(query.cursor),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(toListItem),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.internalId) : null,
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

function clampLimit(limit: number | null): number {
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

/** Carries the sort key AND the id, so the order is total and pages cannot skip. */
function encodeCursor(createdAt: Date, id: number): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), i: id })).toString('base64url');
}

function decodeCursor(cursor: string | null): { createdAt: Date; id: number } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t: string;
      i: number;
    };
    if (typeof parsed.i !== 'number' || typeof parsed.t !== 'string') return null;
    const createdAt = new Date(parsed.t);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.i };
  } catch {
    // Opaque to clients, so there is nothing useful to say: restart at the top.
    return null;
  }
}
