import { Injectable } from '@nestjs/common';
import { RewardEntitlementStatus } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface RewardEntitlementRow {
  readonly id: number;
  readonly refId: string;
  readonly itemRef: string;
  readonly status: RewardEntitlementStatus;
  readonly redemptionCode: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date | null;
}

@Injectable()
export class RewardEntitlementRepository extends BaseRepository {
  async issue(input: {
    enterpriseId: number;
    customerId: number;
    awardId: number;
    itemRef: string;
    redemptionCode: string;
    expiresAt: Date | null;
  }): Promise<RewardEntitlementRow> {
    const { rows } = await this.mutate<RewardEntitlementRow>(
      `INSERT INTO reward_entitlements
              (enterprise_id, customer_id, award_id, item_ref, redemption_code, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, ref_id AS "refId", item_ref AS "itemRef", status,
                 redemption_code AS "redemptionCode", issued_at AS "issuedAt",
                 expires_at AS "expiresAt"`,
      [
        input.enterpriseId,
        input.customerId,
        input.awardId,
        input.itemRef,
        input.redemptionCode,
        input.expiresAt,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('issue entitlement returned no row');
    return row;
  }

  /**
   * Withdraws an issued right.
   *
   * REVOKED, not deleted: the row is the record that it was once issued, and a
   * customer who was shown a code deserves an explanation rather than a row
   * that never existed. Guarded on the CURRENT status so revoking something
   * already redeemed is refused — the coffee has been drunk.
   */
  async revokeIfUnredeemed(enterpriseId: number, entitlementId: number): Promise<boolean> {
    const { affected } = await this.mutate(
      `UPDATE reward_entitlements SET status = $3
        WHERE id = $1 AND enterprise_id = $2 AND status = $4`,
      [
        entitlementId,
        enterpriseId,
        RewardEntitlementStatus.Revoked,
        RewardEntitlementStatus.Issued,
      ],
    );
    return affected > 0;
  }

  /** A customer's issued rights, bounded and newest first. */
  /**
   * Moves lapsed entitlements to `expired`.
   *
   * `expires_at` was written on every issue and read by nothing, so an
   * entitlement whose window had closed stayed `issued` for ever and kept
   * being presented to the business as a live right somebody could still
   * claim. `RewardEntitlementStatus.Expired` was declared and unreachable.
   *
   * ONLY FROM `issued`. A `revoked` or `redeemed` row has already reached a
   * terminal state and must not be relabelled — what happened to it is the
   * thing the status exists to record.
   *
   * Batched, like every other sweep here: a single capped pass cannot keep up
   * with a service issuing more than that, and the table would grow a backlog
   * of lapsed rows while the sweep looked like it ran.
   */
  async expireLapsed(limit: number): Promise<number> {
    const { rows } = await this.mutate<{ id: number }>(
      `UPDATE reward_entitlements
          SET status = $1
        WHERE id IN (
          SELECT id FROM reward_entitlements
           WHERE status = $2
             AND expires_at IS NOT NULL
             AND expires_at <= now()
             AND is_deleted = false
           ORDER BY expires_at
           LIMIT $3
        )
      RETURNING id`,
      [RewardEntitlementStatus.Expired, RewardEntitlementStatus.Issued, limit],
    );
    return rows.length;
  }

  async listForCustomer(
    enterpriseId: number,
    customerId: number,
    limit: number,
  ): Promise<RewardEntitlementRow[]> {
    return this.query<RewardEntitlementRow>(
      `SELECT id, ref_id AS "refId", item_ref AS "itemRef", status,
              redemption_code AS "redemptionCode", issued_at AS "issuedAt",
              expires_at AS "expiresAt"
         FROM reward_entitlements
        WHERE enterprise_id = $1 AND customer_id = $2 AND is_deleted = false
        ORDER BY issued_at DESC, id DESC
        LIMIT $3`,
      [enterpriseId, customerId, limit],
    );
  }
}
