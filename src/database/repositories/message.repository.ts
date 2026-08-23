import { Injectable } from '@nestjs/common';
import { MessageDirection, MessageKind, MessageStatus } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface InsertInboundMessageInput {
  readonly enterpriseId: number;
  readonly conversationId: number;
  readonly customerId: number;
  readonly inboundEventId: number;
  /** The platform's id. Present for inbound, which is what makes dedup work. */
  readonly platformMessageId: string;
  readonly messageKind: MessageKind;
  readonly body: string | null;
  readonly platformSentAt: Date | null;
  readonly parentMessageId: number | null;
}

export interface InsertOutboundMessageInput {
  readonly enterpriseId: number;
  readonly conversationId: number;
  readonly customerId: number | null;
  readonly sentByEmployeeId: number;
  readonly body: string;
  readonly messageKind: MessageKind;
  /** Client-supplied, so a double-click cannot post twice. */
  readonly idempotencyKey: string | null;
  readonly parentMessageId: number | null;
  /**
   * A team-only note: stored, shown to colleagues, never sent anywhere.
   *
   * It was previously accepted by the service and then dropped here, so every
   * note was stored as an ordinary customer-facing reply — indistinguishable in
   * the data from something the customer can read.
   */
  readonly isInternalNote: boolean;
}

export interface MessageRow {
  readonly id: number;
  readonly refId: string;
  readonly direction: MessageDirection;
  readonly body: string | null;
  readonly messageKind: MessageKind;
  readonly status: MessageStatus;
  readonly isRead: boolean;
  readonly isInternalNote: boolean;
  readonly platformSentAt: Date | null;
  readonly createdAt: Date;
  readonly customerId: number | null;
  readonly sentByEmployeeId: number | null;
}

@Injectable()
export class MessageRepository extends BaseRepository {
  /**
   * Records an inbound message.
   *
   * ON CONFLICT on messages_platform_uniq is the projector's idempotency guard:
   * a retried projection, or the same comment arriving by both webhook and
   * backfill, must not produce two rows. Returns null when it was a duplicate,
   * so the caller knows not to double-count the conversation's counters.
   *
   * The key is scoped to the ENTERPRISE, not the conversation: a comment id is
   * unique platform-wide, and conversation scoping would let the same comment
   * exist twice if a backfill and a webhook resolved it into different threads.
   */
  async insertInbound(
    input: InsertInboundMessageInput,
  ): Promise<{ id: number; refId: string } | null> {
    const { rows } = await this.mutate<{ id: number; ref_id: string }>(
      `INSERT INTO messages
         (enterprise_id, conversation_id, direction, customer_id, inbound_event_id,
          platform_message_id, message_kind, body, platform_sent_at, parent_message_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (enterprise_id, platform_message_id) WHERE platform_message_id IS NOT NULL
       DO NOTHING
       RETURNING id, ref_id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.conversationId,
        MessageDirection.Inbound,
        input.customerId,
        input.inboundEventId,
        input.platformMessageId,
        input.messageKind,
        input.body,
        input.platformSentAt,
        input.parentMessageId,
        MessageStatus.Delivered,
      ],
    );
    const row = rows[0];
    return row ? { id: row.id, refId: row.ref_id } : null;
  }

  /**
   * Records an outbound message as PENDING.
   *
   * Called inside the caller's transaction alongside the outbound_events row —
   * the transactional outbox rule. The relay sends after commit; nothing here
   * touches the network.
   */
  async insertOutbound(input: InsertOutboundMessageInput): Promise<{ id: number; refId: string }> {
    const { rows } = await this.mutate<{ id: number; ref_id: string }>(
      `INSERT INTO messages
         (enterprise_id, conversation_id, direction, customer_id, sent_by_employee_id,
          message_kind, body, idempotency_key, parent_message_id, status, is_read,
          is_internal_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11)
       RETURNING id, ref_id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.conversationId,
        MessageDirection.Outbound,
        input.customerId,
        input.sentByEmployeeId,
        input.messageKind,
        input.body,
        input.idempotencyKey,
        input.parentMessageId,
        /*
         * A note is DELIVERED the moment it is stored: its audience is the team,
         * and no relay will ever touch it. Left as Pending it sat in the thread
         * looking like a reply stuck in the queue, forever.
         */
        input.isInternalNote ? MessageStatus.Delivered : MessageStatus.Pending,
        input.isInternalNote,
      ],
    );
    const row = rows[0];
    // A duplicate idempotency key raises 23505, which BaseRepository translates
    // into DUPLICATE_MESSAGE — so a retry gets a clean 409 rather than a second
    // message.
    if (!row) throw new Error('messages insert returned no row');
    return { id: row.id, refId: row.ref_id };
  }

  /**
   * Lets a retry return the original result instead of erroring.
   *
   * It returns what the key was ORIGINALLY used for, not just the outcome. The
   * uniqueness index is (enterprise_id, idempotency_key), so a client that reuses
   * a key on a different conversation used to be handed the first conversation's
   * message and told its reply had been accepted — the reply to the second
   * customer was never written and nothing anywhere said so. The caller compares
   * these fields and refuses the mismatch.
   */
  async findByIdempotencyKey(
    enterpriseId: number,
    idempotencyKey: string,
  ): Promise<{
    id: number;
    refId: string;
    status: MessageStatus;
    conversationId: number;
    isInternalNote: boolean;
  } | null> {
    const rows = await this.query<{
      id: number;
      refId: string;
      status: MessageStatus;
      conversationId: number;
      isInternalNote: boolean;
    }>(
      `SELECT id, ref_id AS "refId", status,
              conversation_id AS "conversationId", is_internal_note AS "isInternalNote"
         FROM messages
        WHERE enterprise_id = $1 AND idempotency_key = $2
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), idempotencyKey],
    );
    return rows[0] ?? null;
  }

  async linkOutboundEvent(
    enterpriseId: number,
    messageId: number,
    outboundEventId: number,
  ): Promise<void> {
    await this.mutate(
      `UPDATE messages SET outbound_event_id = $3 WHERE id = $2 AND enterprise_id = $1`,
      [this.requireEnterprise(enterpriseId), messageId, outboundEventId],
    );
  }

  /**
   * The delivery write-back, keyed on the ledger row rather than the message —
   * which is why messages_outbound_event_idx exists. The relay knows which event
   * it sent, not which message.
   */
  async recordDelivery(
    outboundEventId: number,
    platformMessageId: string | null,
    status: MessageStatus,
  ): Promise<void> {
    await this.mutate(
      // $2 and $3 are cast explicitly: without the casts Postgres sees $3 used
      // both as a column value and inside a comparison, and fails with
      // "inconsistent types deduced for parameter $3".
      `UPDATE messages
          SET platform_message_id = COALESCE($2::varchar, platform_message_id),
              status = $3::varchar,
              platform_sent_at = CASE WHEN $3::varchar = 'sent'
                                      THEN now() ELSE platform_sent_at END
        WHERE outbound_event_id = $1`,
      [outboundEventId, platformMessageId, status],
    );
  }

  /**
   * Reads a thread. Ordered on COALESCE(platform_sent_at, created_at) to match
   * messages_thread_idx: internal notes and still-queued sends have no platform
   * timestamp and must interleave by creation time rather than sink to the end.
   */
  async listThread(
    enterpriseId: number,
    conversationId: number,
    limit: number,
    cursor: { sortedAt: Date; id: number } | null,
  ): Promise<MessageRow[]> {
    const params: unknown[] = [this.requireEnterprise(enterpriseId), conversationId, limit];
    let keyset = '';
    if (cursor) {
      params.push(cursor.sortedAt, cursor.id);
      /*
       * The keyset compares the SAME expression the ORDER BY sorts on. It used
       * to be a bare `id < $n`, which is only equivalent while id order matches
       * time order — and the backfill worker breaks exactly that, appending
       * years-old messages long after today's webhooks. A thread with any
       * backfilled history therefore hid some messages from page two and
       * repeated others. No null branch is needed here: created_at is NOT NULL,
       * so the COALESCE never yields null.
       */
      keyset =
        `AND (COALESCE(platform_sent_at, created_at), id) ` +
        `< ($${params.length - 1}::timestamptz, $${params.length})`;
    }

    return this.query<MessageRow>(
      `SELECT id, ref_id AS "refId", direction, body, message_kind AS "messageKind", status,
              is_read AS "isRead", is_internal_note AS "isInternalNote",
              platform_sent_at AS "platformSentAt", created_at AS "createdAt",
              customer_id AS "customerId", sent_by_employee_id AS "sentByEmployeeId"
         FROM messages
        WHERE enterprise_id = $1
          AND conversation_id = $2
          AND is_deleted = false
          ${keyset}
        ORDER BY COALESCE(platform_sent_at, created_at) DESC, id DESC
        LIMIT $3`,
      params,
    );
  }

  /**
   * Where a given message sits in the thread's order, so the deprecated
   * `beforeId` query parameter can be translated into a correct keyset instead
   * of paginating on an id that does not match the sort.
   */
  async findThreadPosition(
    enterpriseId: number,
    conversationId: number,
    messageId: number,
  ): Promise<{ sortedAt: Date; id: number } | null> {
    const rows = await this.query<{ sortedAt: Date; id: number }>(
      `SELECT COALESCE(platform_sent_at, created_at) AS "sortedAt", id
         FROM messages
        WHERE enterprise_id = $1 AND conversation_id = $2 AND id = $3
          AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), conversationId, messageId],
    );
    return rows[0] ?? null;
  }

  /** Resolves a platform comment id to our row, for threading replies. */
  async findIdByPlatformId(
    enterpriseId: number,
    platformMessageId: string,
  ): Promise<number | null> {
    const rows = await this.query<{ id: number }>(
      `SELECT id FROM messages
        WHERE enterprise_id = $1 AND platform_message_id = $2
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), platformMessageId],
    );
    return rows[0]?.id ?? null;
  }
}
