import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';

export interface CallbackRequestRow {
  readonly refId: string;
  readonly phone: string;
  readonly reason: string;
  readonly whenReachable: string | null;
  readonly status: string;
  readonly createdAt: Date;
}

/** What is already promised, so nothing promises it twice. */
export interface OpenCallback {
  readonly refId: string;
  readonly reason: string;
  readonly createdAt: Date;
}

@Injectable()
export class CallbackRequestRepository extends BaseRepository {
  /**
   * Records that somebody should be rung.
   *
   * RETURNS WHAT IS ALREADY OPEN RATHER THAN FAILING. The partial unique
   * index allows one open request per conversation, and a second attempt is
   * not an error — it is a customer asking again, or a model making sure.
   * Both want the same answer: "that is already booked, here it is". A
   * thrown constraint violation would force the caller to tell the model
   * something went wrong, which is both untrue and the kind of thing it
   * will try to fix by trying again.
   */
  async open(input: {
    enterpriseId: number;
    conversationId: number;
    customerId: number;
    messageId: number | null;
    phone: string;
    reason: string;
    whenReachable: string | null;
    requestedBy: string;
  }): Promise<{ created: boolean; row: CallbackRequestRow }> {
    const inserted = await this.query<CallbackRequestRow>(
      `INSERT INTO callback_requests
         (enterprise_id, conversation_id, customer_id, message_id, phone, reason,
          when_reachable, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (enterprise_id, conversation_id)
         WHERE is_deleted = false AND status = 'requested'
       DO NOTHING
       RETURNING ref_id AS "refId", phone, reason,
                 when_reachable AS "whenReachable", status, created_at AS "createdAt"`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.conversationId,
        input.customerId,
        input.messageId,
        input.phone,
        input.reason,
        input.whenReachable,
        input.requestedBy,
      ],
    );

    const row = inserted[0];
    if (row) return { created: true, row };

    /*
     * Lost to the index, so read back what holds the slot. Not an error:
     * the customer's request IS recorded, by the row that got there first,
     * and that is what the caller needs to be able to say.
     */
    const existing = await this.findOpen(input.enterpriseId, input.conversationId);
    if (existing) {
      return {
        created: false,
        row: {
          refId: existing.refId,
          phone: input.phone,
          reason: existing.reason,
          whenReachable: input.whenReachable,
          status: 'requested',
          createdAt: existing.createdAt,
        },
      };
    }

    /*
     * The open row was closed between the insert and the read. Vanishingly
     * rare and not worth a transaction: try once more, and if that loses
     * too, let the error surface rather than loop.
     */
    const retried = await this.query<CallbackRequestRow>(
      `INSERT INTO callback_requests
         (enterprise_id, conversation_id, customer_id, message_id, phone, reason,
          when_reachable, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ref_id AS "refId", phone, reason,
                 when_reachable AS "whenReachable", status, created_at AS "createdAt"`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.conversationId,
        input.customerId,
        input.messageId,
        input.phone,
        input.reason,
        input.whenReachable,
        input.requestedBy,
      ],
    );
    const second = retried[0];
    if (!second) throw new Error('the callback request could not be recorded');
    return { created: true, row: second };
  }

  /** The one still outstanding on this conversation, when there is one. */
  async findOpen(enterpriseId: number, conversationId: number): Promise<OpenCallback | null> {
    const rows = await this.query<OpenCallback>(
      `SELECT ref_id AS "refId", reason, created_at AS "createdAt"
         FROM callback_requests
        WHERE enterprise_id = $1 AND conversation_id = $2
          AND is_deleted = false AND status = 'requested'
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), conversationId],
    );
    return rows[0] ?? null;
  }
}
