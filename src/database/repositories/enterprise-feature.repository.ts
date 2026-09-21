import { Injectable } from '@nestjs/common';
import { EnterpriseFeatureStatus, FeatureStatus } from '@/shared/enums';
import { BaseRepository } from './base.repository';

/** What a business has, and what it could ask for. */
export interface EnterpriseFeatureRow {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  /** NULL when the business has never had a row for this feature at all. */
  readonly status: EnterpriseFeatureStatus | null;
  readonly enabledAt: Date | null;
  readonly expiresAt: Date | null;
  readonly declineReason: string | null;
}

/**
 * A business's own view of what it has bought.
 *
 * SEPARATE FROM PlatformAdminRepository on purpose. That one answers "show me
 * any business", is not tenant-scoped, and is reachable only by platform staff.
 * This one is tenant-scoped in the ordinary way and is reachable by the
 * business itself — putting both behind one class would mean one missing
 * `enterprise_id` turns a tenant read into a platform read.
 */
@Injectable()
export class EnterpriseFeatureRepository extends BaseRepository {
  /**
   * Every feature we sell, with this business's standing on each.
   *
   * A LEFT JOIN from `features`, not from `enterprise_features`, because a
   * feature never requested has no row — and the interesting thing to show
   * somebody is the one they do NOT have yet. Reading it the other way round
   * would make the list of what a business could buy invisible to the business.
   */
  async listForEnterprise(enterpriseId: number): Promise<EnterpriseFeatureRow[]> {
    return this.query<EnterpriseFeatureRow>(
      `SELECT f.key,
              f.name,
              f.description,
              ef.status          AS "status",
              ef.enabled_at      AS "enabledAt",
              ef.expires_at      AS "expiresAt",
              ef.decline_reason  AS "declineReason"
         FROM features f
         LEFT JOIN enterprise_features ef
                ON ef.feature_id = f.id AND ef.enterprise_id = $1 AND ef.is_deleted = false
        WHERE f.is_deleted = false AND f.status <> $2
        ORDER BY f.name`,
      [this.requireEnterprise(enterpriseId), FeatureStatus.Deprecated],
    );
  }

  /**
   * Records a business asking for a feature.
   *
   * IDEMPOTENT AND NARROW. The conflict target is the live row, and the update
   * fires only from the two states a request may legally leave: never requested
   * (no row) and `declined`. It deliberately cannot move `revoked` — that is
   * withdrawn by us and is not self-serve re-enableable, which is the one line
   * the feature state machine is emphatic about — and it cannot move `active`,
   * where a request is meaningless.
   *
   * Returns the row only when something changed, so the caller can tell a real
   * request from a repeat without a second query.
   */
  async requestAccess(input: {
    enterpriseId: number;
    featureKey: string;
    requestedByEmployeeId: number;
  }): Promise<{ status: EnterpriseFeatureStatus } | null> {
    const { rows } = await this.mutate<{ status: EnterpriseFeatureStatus }>(
      `INSERT INTO enterprise_features
         (enterprise_id, feature_id, status, requested_by_employee_id, requested_at)
       SELECT $1, f.id, $3, $4, now()
         FROM features f
        WHERE f.key = $2 AND f.is_deleted = false AND f.status <> $5
       ON CONFLICT (enterprise_id, feature_id) WHERE is_deleted = false
       DO UPDATE SET
         status = $3,
         requested_by_employee_id = $4,
         requested_at = now(),
         decline_reason = NULL,
         updated_at = now()
       WHERE enterprise_features.status = $6
       RETURNING status`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.featureKey,
        EnterpriseFeatureStatus.AccessRequested,
        input.requestedByEmployeeId,
        FeatureStatus.Deprecated,
        EnterpriseFeatureStatus.Declined,
      ],
    );
    return rows[0] ?? null;
  }

  /** What this business's standing on one feature is, or null if it has none. */
  async currentStatus(
    enterpriseId: number,
    featureKey: string,
  ): Promise<EnterpriseFeatureStatus | null> {
    const rows = await this.query<{ status: EnterpriseFeatureStatus }>(
      `SELECT ef.status
         FROM enterprise_features ef
         JOIN features f ON f.id = ef.feature_id
        WHERE ef.enterprise_id = $1 AND f.key = $2 AND ef.is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), featureKey],
    );
    return rows[0]?.status ?? null;
  }

  /**
   * Moves features whose term has run out from `active` to `expired`.
   *
   * NOT tenant-scoped, because it is a sweep across every business — the one
   * query in this class that is, and the reason it takes a batch limit.
   *
   * The predicate repeats `enterprise_features_expiry_idx` exactly. That index
   * has existed since the first migration for a sweep that was never written,
   * so a trial with an `expires_at` in the past stayed ACTIVE for ever and the
   * business kept the feature. The index was the plan; this is the sweep.
   */
  async expireDue(limit: number): Promise<number> {
    const { rows } = await this.mutate<{ id: string }>(
      `UPDATE enterprise_features
          SET status = $1, disabled_at = now(), updated_at = now()
        WHERE id IN (
          SELECT id FROM enterprise_features
           WHERE is_deleted = false
             AND status = $2
             AND expires_at IS NOT NULL
             AND expires_at <= now()
           ORDER BY expires_at
           LIMIT $3
        )
        RETURNING id`,
      [EnterpriseFeatureStatus.Expired, EnterpriseFeatureStatus.Active, limit],
    );
    return rows.length;
  }
}
