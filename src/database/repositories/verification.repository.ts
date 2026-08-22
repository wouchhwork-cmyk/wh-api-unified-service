import { Injectable } from '@nestjs/common';
import { DeliveryChannel, VerificationKind, VerificationSubjectKind } from '@/shared/enums';
import { Verification } from '../entities/verification.entity';
import { BaseRepository } from './base.repository';

export interface CreateVerificationInput {
  readonly subjectKind: VerificationSubjectKind;
  readonly identityId: number | null;
  readonly enterpriseId: number | null;
  readonly customerId: number | null;
  readonly customerIdentifierId: number | null;
  readonly verificationKind: VerificationKind;
  readonly deliveryChannel: DeliveryChannel;
  readonly destination: string;
  readonly secretHash: string;
  readonly expiresAt: Date;
  readonly maxAttempts: number;
  readonly requestedIp: string | null;
  readonly requestedUserAgent: string | null;
}

@Injectable()
export class VerificationRepository extends BaseRepository {
  /**
   * Issuing SUPERSEDES. A new code for the same subject/kind/destination marks
   * the previous row superseded in the SAME transaction as the insert — which is
   * what verifications_live_uniq enforces, and what stops two live codes existing
   * where a user requesting a resend could unknowingly validate the older one.
   *
   * COALESCE mirrors the index expression exactly, because the subject is
   * polymorphic and NULLs would otherwise never match.
   */
  async supersedeLive(input: {
    identityId: number | null;
    customerId: number | null;
    verificationKind: VerificationKind;
    destination: string;
  }): Promise<number> {
    const { affected } = await this.mutate(
      `UPDATE verifications
          SET superseded_at = now()
        WHERE COALESCE(identity_id, 0) = COALESCE($1::bigint, 0)
          AND COALESCE(customer_id, 0) = COALESCE($2::bigint, 0)
          AND verification_kind = $3
          AND destination = $4
          AND consumed_at IS NULL
          AND superseded_at IS NULL
          AND is_deleted = false
        RETURNING id`,
      [input.identityId, input.customerId, input.verificationKind, input.destination],
    );
    return affected;
  }

  async create(input: CreateVerificationInput): Promise<Verification> {
    return this.guard(async () => {
      const verification = this.repo(Verification).create({
        ...input,
        lastSentAt: new Date(),
      });
      return this.repo(Verification).save(verification);
    });
  }

  /**
   * The verify lookup is by ref_id — the client posts back the opaque
   * verificationRefId, never the destination. That keeps the address out of a
   * second request and removes any chance of verifying a code against a
   * different address than it was sent to.
   */
  async findLiveByRefId(refId: string, kind: VerificationKind): Promise<Verification | null> {
    const rows = await this.repo(Verification)
      .createQueryBuilder('v')
      .where('v.refId = :refId', { refId })
      .andWhere('v.verificationKind = :kind', { kind })
      .andWhere('v.consumedAt IS NULL')
      .andWhere('v.supersededAt IS NULL')
      .andWhere('v.isDeleted = false')
      .limit(1)
      .getMany();
    return rows[0] ?? null;
  }

  /**
   * Spends one attempt from the budget, atomically.
   *
   * Called BEFORE the secret is compared, which is what makes the limit real:
   * comparing first and incrementing after let concurrent requests all pass the
   * check against a stale count. Returns the new count, or null when the budget
   * was already spent — in which case no comparison should happen at all.
   *
   * A successful verification also spends an attempt. That is harmless: the row
   * is consumed in the same breath, and it keeps the budget honest for the
   * concurrent case.
   */
  async spendAttempt(id: number): Promise<number | null> {
    const { rows } = await this.mutate<{ attempt_count: number }>(
      `UPDATE verifications
          SET attempt_count = attempt_count + 1
        WHERE id = $1 AND attempt_count < max_attempts
        RETURNING attempt_count`,
      [id],
    );
    return rows[0]?.attempt_count ?? null;
  }

  /** Single use: only an unconsumed row can be consumed, so a replay finds nothing. */
  async consume(id: number): Promise<boolean> {
    const { affected } = await this.mutate(
      `UPDATE verifications SET consumed_at = now()
        WHERE id = $1 AND consumed_at IS NULL AND superseded_at IS NULL
        RETURNING id`,
      [id],
    );
    return affected === 1;
  }

  /**
   * The hourly cap per destination. Without it this endpoint is a free SMS pump
   * billed to us. Uses verifications_destination_idx.
   */
  async countSentToDestinationSince(destination: string, since: Date): Promise<number> {
    const rows = await this.query<{ count: string }>(
      `SELECT count(*) AS count FROM verifications
        WHERE destination = $1 AND created_at >= $2`,
      [destination, since],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async recordResend(id: number): Promise<void> {
    await this.query(
      `UPDATE verifications SET resend_count = resend_count + 1, last_sent_at = now() WHERE id = $1`,
      [id],
    );
  }

  async linkOutboundEvent(id: number, outboundEventId: number): Promise<void> {
    await this.query(`UPDATE verifications SET outbound_event_id = $2 WHERE id = $1`, [
      id,
      outboundEventId,
    ]);
  }

  /** Retention sweep: consumed and expired rows go after a short window. */
  async deleteSettledBefore(cutoff: Date, limit: number): Promise<number> {
    const { affected } = await this.mutate(
      `DELETE FROM verifications
        WHERE id IN (
          SELECT id FROM verifications
           WHERE (consumed_at IS NOT NULL AND consumed_at < $1)
              OR (expires_at < $1)
           LIMIT $2
        )
        RETURNING id`,
      [cutoff, limit],
    );
    return affected;
  }
}
