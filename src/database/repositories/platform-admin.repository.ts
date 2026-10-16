import { Injectable } from '@nestjs/common';
import {
  ChannelStatus,
  ConnectionStatus,
  EnterpriseFeatureStatus,
  EnterpriseStatus,
  EmployeeStatus,
} from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface PlatformEnterpriseRow {
  /**
   * The internal key, needed to build the pagination cursor. STRIPPED BY THE
   * SERVICE before anything is returned to a client — a sequential id in an API
   * response tells the reader how many businesses exist and lets them probe for
   * neighbours.
   */
  readonly internalId: number;
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
  readonly employeeCount: number;
  readonly channelCount: number;
  readonly connectionCount: number;
  readonly customerCount: number;
  readonly conversationCount: number;
  readonly activeFeatureCount: number;
  readonly pendingFeatureCount: number;
}

export interface PlatformEnterpriseCursor {
  readonly createdAt: Date;
  readonly id: number;
}

export interface ListEnterprisesFilter {
  readonly search: string | null;
  readonly status: EnterpriseStatus | null;
  readonly limit: number;
  readonly cursor: PlatformEnterpriseCursor | null;
}

export interface PlatformEnterpriseOwner {
  readonly firstName: string;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly mobile: string | null;
  readonly emailVerifiedAt: Date | null;
  readonly mobileVerifiedAt: Date | null;
  readonly lastLoginAt: Date | null;
}

export interface PlatformFeatureRow {
  readonly featureKey: string;
  readonly featureName: string;
  readonly description: string | null;
  /** null when this business has never had a row for the feature. */
  readonly status: EnterpriseFeatureStatus | null;
  readonly requestedAt: Date | null;
  readonly decidedAt: Date | null;
  readonly enabledAt: Date | null;
  readonly declineReason: string | null;
}

export interface PlatformChannelRow {
  readonly channelRefId: string;
  readonly platform: string;
  readonly channelKind: string;
  readonly displayName: string | null;
  readonly platformChannelId: string;
  readonly channelStatus: ChannelStatus;
  readonly connectionStatus: ConnectionStatus;
  /** When the connection row was created — provider_connections has no separate
   *  connected_at column. */
  readonly connectedAt: Date | null;
}

export interface PlatformOverview {
  readonly enterprisesTotal: number;
  readonly enterprisesPending: number;
  readonly enterprisesActive: number;
  readonly enterprisesSuspended: number;
  readonly customersTotal: number;
  readonly channelsTotal: number;
  readonly conversationsTotal: number;
  readonly featureRequestsPending: number;
}

/**
 * The internal platform view: every business, deliberately unscoped.
 *
 * EVERY OTHER REPOSITORY IN THIS CODEBASE IS TENANT-SCOPED, AND THIS ONE IS NOT.
 * That is the whole point of it, and the reason it is a separate file with a
 * separate name rather than extra methods hidden among the tenant repositories —
 * a reviewer should be able to find every cross-tenant query by opening one file.
 *
 * Nothing here is reachable except behind PlatformAdminGuard, and nothing here
 * writes tenant CONTENT: it changes commercial state (is this business switched
 * on, does it have this feature) and reads counts. No conversation, message, or
 * customer row is ever returned by this class, so "look at every business" never
 * becomes "read every business's inbox".
 */
/**
 * The per-business counts, shared by the list and the detail query so the two
 * can never disagree about what "total customers" means.
 *
 * Placeholder contract: $1 is the caller's own key (a page limit or a ref_id),
 * and $2..$4 are the three status constants, in this order. Correlated
 * subqueries are acceptable here only because both callers are bounded — each is
 * an index-only count on `enterprise_id`.
 */
const ENTERPRISE_COUNT_COLUMNS = `
              (SELECT count(*)::int FROM enterprise_employees m
                 WHERE m.enterprise_id = e.id AND m.is_deleted = false
                   AND m.status = $2::varchar)                     AS "employeeCount",
              (SELECT count(*)::int FROM channels c
                 WHERE c.enterprise_id = e.id AND c.is_deleted = false) AS "channelCount",
              (SELECT count(*)::int FROM provider_connections pc
                 WHERE pc.enterprise_id = e.id AND pc.is_deleted = false) AS "connectionCount",
              (SELECT count(*)::int FROM customers cu
                 WHERE cu.enterprise_id = e.id AND cu.is_deleted = false) AS "customerCount",
              (SELECT count(*)::int FROM conversations cv
                 WHERE cv.enterprise_id = e.id AND cv.is_deleted = false) AS "conversationCount",
              (SELECT count(*)::int FROM enterprise_features ef
                 WHERE ef.enterprise_id = e.id AND ef.is_deleted = false
                   AND ef.status = $3::varchar)                    AS "activeFeatureCount",
              (SELECT count(*)::int FROM enterprise_features ef
                 WHERE ef.enterprise_id = e.id AND ef.is_deleted = false
                   AND ef.status = $4::varchar)                    AS "pendingFeatureCount"`;

/** The identity columns, likewise shared. */
const ENTERPRISE_BASE_COLUMNS = `
              e.id       AS "internalId",
              e.ref_id   AS "refId",
              e.name     AS "name",
              e.slug     AS "slug",
              e.email    AS "email",
              e.mobile   AS "mobile",
              e.status   AS "status",
              e.city     AS "city",
              e.country  AS "country",
              e.timezone AS "timezone",
              e.created_at AS "createdAt",`;

@Injectable()
export class PlatformAdminRepository extends BaseRepository {
  /**
   * Keyset pagination on (created_at, id). The id is the tiebreaker that makes
   * the order total — two businesses created in the same millisecond would
   * otherwise be able to swap places between pages, and one of them would never
   * be shown at all.
   */
  async listEnterprises(filter: ListEnterprisesFilter): Promise<PlatformEnterpriseRow[]> {
    // Fixed positions first so the dynamic predicates below can append freely.
    // Bound, not interpolated: these are constants today, and a query that
    // concatenates *anything* into SQL is one careless edit away from taking a
    // value that is not.
    const params: unknown[] = [
      filter.limit,
      EmployeeStatus.Active,
      EnterpriseFeatureStatus.Active,
      EnterpriseFeatureStatus.AccessRequested,
    ];
    const where: string[] = ['e.is_deleted = false'];

    if (filter.status !== null) {
      params.push(filter.status);
      where.push(`e.status = $${params.length}::varchar`);
    }

    if (filter.search !== null) {
      params.push(`%${filter.search}%`);
      // Trailing wildcard only would miss "coffee" in "Acme Coffee". The
      // leading one forfeits the index, which is affordable here and nowhere
      // near a hot path: this table stays small next to conversations.
      where.push(
        `(e.name ILIKE $${params.length} OR e.slug ILIKE $${params.length} OR e.email ILIKE $${params.length})`,
      );
    }

    if (filter.cursor !== null) {
      params.push(filter.cursor.createdAt, filter.cursor.id);
      where.push(
        `(e.created_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`,
      );
    }

    return this.query<PlatformEnterpriseRow>(
      `SELECT ${ENTERPRISE_BASE_COLUMNS}
              ${ENTERPRISE_COUNT_COLUMNS}
         FROM enterprises e
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $1`,
      params,
    );
  }

  /** One business, with exactly the same counts the list shows. */
  async findEnterpriseByRefId(refId: string): Promise<PlatformEnterpriseRow | null> {
    const rows = await this.query<PlatformEnterpriseRow>(
      `SELECT ${ENTERPRISE_BASE_COLUMNS}
              ${ENTERPRISE_COUNT_COLUMNS}
         FROM enterprises e
        WHERE e.ref_id = $1::uuid AND e.is_deleted = false
        LIMIT 1`,
      [
        refId,
        EmployeeStatus.Active,
        EnterpriseFeatureStatus.Active,
        EnterpriseFeatureStatus.AccessRequested,
      ],
    );
    return rows[0] ?? null;
  }

  /** The internal id, needed by everything that follows. Never exposed. */
  async findIdByRefId(refId: string): Promise<{ id: number; status: EnterpriseStatus } | null> {
    const rows = await this.query<{ id: number; status: EnterpriseStatus }>(
      `SELECT id, status FROM enterprises WHERE ref_id = $1::uuid AND is_deleted = false LIMIT 1`,
      [refId],
    );
    return rows[0] ?? null;
  }

  /**
   * The person who created the business: the oldest active enterprise-kind
   * employment. Ordered by id so the answer is deterministic when two
   * employments share a timestamp.
   */
  async findOwner(enterpriseId: number): Promise<PlatformEnterpriseOwner | null> {
    const rows = await this.query<PlatformEnterpriseOwner>(
      `SELECT i.first_name         AS "firstName",
              i.last_name          AS "lastName",
              i.email              AS "email",
              i.mobile             AS "mobile",
              i.email_verified_at  AS "emailVerifiedAt",
              i.mobile_verified_at AS "mobileVerifiedAt",
              i.last_login_at      AS "lastLoginAt"
         FROM enterprise_employees m
         JOIN identities i ON i.id = m.identity_id AND i.is_deleted = false
        WHERE m.enterprise_id = $1 AND m.is_deleted = false
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT 1`,
      [enterpriseId],
    );
    return rows[0] ?? null;
  }

  /**
   * The whole catalogue LEFT JOINed to this business, so a feature it has never
   * asked for still appears — with a null status. An admin needs to see what
   * could be switched on, not only what already has a row.
   */
  async listFeatures(enterpriseId: number): Promise<PlatformFeatureRow[]> {
    return this.query<PlatformFeatureRow>(
      `SELECT f."key"           AS "featureKey",
              f.name            AS "featureName",
              f.description     AS "description",
              ef.status         AS "status",
              ef.requested_at   AS "requestedAt",
              ef.decided_at     AS "decidedAt",
              ef.enabled_at     AS "enabledAt",
              ef.decline_reason AS "declineReason"
         FROM features f
         LEFT JOIN enterprise_features ef
                ON ef.feature_id = f.id
               AND ef.enterprise_id = $1
               AND ef.is_deleted = false
        WHERE f.is_deleted = false
        ORDER BY f."key" ASC`,
      [enterpriseId],
    );
  }

  /** What the business has actually connected — "what they have configured". */
  async listChannels(enterpriseId: number): Promise<PlatformChannelRow[]> {
    return this.query<PlatformChannelRow>(
      `SELECT c.ref_id             AS "channelRefId",
              c.platform           AS "platform",
              c.channel_kind       AS "channelKind",
              c.name               AS "displayName",
              c.platform_channel_id AS "platformChannelId",
              c.status             AS "channelStatus",
              pc.status            AS "connectionStatus",
              pc.created_at        AS "connectedAt"
         FROM channels c
         JOIN provider_connections pc
              ON pc.id = c.provider_connection_id
             AND pc.enterprise_id = c.enterprise_id
        WHERE c.enterprise_id = $1 AND c.is_deleted = false
        ORDER BY c.created_at ASC, c.id ASC`,
      [enterpriseId],
    );
  }

  async overview(): Promise<PlatformOverview> {
    const rows = await this.query<PlatformOverview>(
      `SELECT (SELECT count(*)::int FROM enterprises WHERE is_deleted = false) AS "enterprisesTotal",
              (SELECT count(*)::int FROM enterprises
                WHERE is_deleted = false AND status = $1::varchar)             AS "enterprisesPending",
              (SELECT count(*)::int FROM enterprises
                WHERE is_deleted = false AND status = $2::varchar)             AS "enterprisesActive",
              (SELECT count(*)::int FROM enterprises
                WHERE is_deleted = false AND status = $3::varchar)             AS "enterprisesSuspended",
              (SELECT count(*)::int FROM customers WHERE is_deleted = false)   AS "customersTotal",
              (SELECT count(*)::int FROM channels
                WHERE is_deleted = false AND status = $4::varchar)             AS "channelsTotal",
              (SELECT count(*)::int FROM conversations WHERE is_deleted = false) AS "conversationsTotal",
              (SELECT count(*)::int FROM enterprise_features
                WHERE is_deleted = false AND status = $5::varchar)             AS "featureRequestsPending"`,
      [
        EnterpriseStatus.PendingActivation,
        EnterpriseStatus.Active,
        EnterpriseStatus.Suspended,
        ChannelStatus.Active,
        EnterpriseFeatureStatus.AccessRequested,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('platform overview returned no row');
    return row;
  }

  /**
   * Moves a business between statuses, conditional on the status it is in.
   *
   * The `AND status = $3` is what makes this safe against two admins clicking at
   * once: the second update matches nothing and the caller sees it did not apply,
   * rather than both succeeding and the later one silently winning.
   */
  async updateEnterpriseStatus(
    enterpriseId: number,
    from: EnterpriseStatus,
    to: EnterpriseStatus,
  ): Promise<boolean> {
    const { affected } = await this.mutate(
      `UPDATE enterprises
          SET status = $2::varchar, updated_at = now()
        WHERE id = $1 AND status = $3::varchar AND is_deleted = false`,
      [enterpriseId, to, from],
    );
    return affected > 0;
  }

  async findFeatureIdByKey(key: string): Promise<number | null> {
    const rows = await this.query<{ id: number }>(
      `SELECT id FROM features WHERE "key" = $1 AND is_deleted = false LIMIT 1`,
      [key],
    );
    return rows[0]?.id ?? null;
  }

  async findEnterpriseFeature(
    enterpriseId: number,
    featureId: number,
  ): Promise<{ id: number; status: EnterpriseFeatureStatus } | null> {
    const rows = await this.query<{ id: number; status: EnterpriseFeatureStatus }>(
      `SELECT id, status FROM enterprise_features
        WHERE enterprise_id = $1 AND feature_id = $2 AND is_deleted = false
        LIMIT 1`,
      [enterpriseId, featureId],
    );
    return rows[0] ?? null;
  }

  /**
   * Grants a feature the business never asked for.
   *
   * ON CONFLICT rather than a check-then-insert: two admins granting the same
   * feature at the same moment would otherwise both pass the check and the
   * second insert would fail on the unique index with a 500.
   */
  async insertEnterpriseFeature(input: {
    enterpriseId: number;
    featureId: number;
    status: EnterpriseFeatureStatus;
    decidedByStaffId: number;
  }): Promise<void> {
    await this.query(
      `INSERT INTO enterprise_features
              (enterprise_id, feature_id, status, decided_by_staff_id, decided_at, enabled_at)
       VALUES ($1, $2, $3::varchar, $4, now(),
               CASE WHEN $3::varchar = $5::varchar THEN now() ELSE NULL END)
       ON CONFLICT (enterprise_id, feature_id) WHERE is_deleted = false
       DO NOTHING`,
      [
        input.enterpriseId,
        input.featureId,
        input.status,
        input.decidedByStaffId,
        EnterpriseFeatureStatus.Active,
      ],
    );
  }

  /** Conditional on the current status, for the same reason as the enterprise move. */
  async updateEnterpriseFeatureStatus(input: {
    enterpriseFeatureId: number;
    from: EnterpriseFeatureStatus;
    to: EnterpriseFeatureStatus;
    decidedByStaffId: number;
    declineReason: string | null;
  }): Promise<boolean> {
    const { affected } = await this.mutate(
      `UPDATE enterprise_features
          SET status = $2::varchar,
              decided_by_staff_id = $4,
              decided_at = now(),
              decline_reason = $5,
              enabled_at = CASE WHEN $2::varchar = $6::varchar
                                THEN now() ELSE enabled_at END,
              disabled_at = CASE WHEN $2::varchar IN ($7::varchar, $8::varchar)
                                THEN now() ELSE disabled_at END,
              updated_at = now()
        WHERE id = $1 AND status = $3::varchar AND is_deleted = false`,
      [
        input.enterpriseFeatureId,
        input.to,
        input.from,
        input.decidedByStaffId,
        input.declineReason,
        EnterpriseFeatureStatus.Active,
        EnterpriseFeatureStatus.Disabled,
        EnterpriseFeatureStatus.Revoked,
      ],
    );
    return affected > 0;
  }
}
