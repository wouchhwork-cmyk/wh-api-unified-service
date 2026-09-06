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
  /** Set alongside the message_attachments rows the caller is about to write. */
  readonly hasAttachments?: boolean;
  /**
   * Platform facts with no column of their own — a reply's parent mid, a quick
   * reply's payload, an ad referral. Kept because they are the raw material for
   * features that do not exist yet, and are unrecoverable once the ledger row
   * ages out.
   */
  readonly metadata?: Record<string, unknown>;
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
  readonly hasAttachments: boolean;
  /**
   * The message this one answers, when the customer replied to one in
   * particular. Its ref_id, never its internal id, and a short excerpt so the
   * thread can show WHAT was answered without the parent having to be on the
   * same page.
   */
  readonly parentRefId: string | null;
  readonly parentExcerpt: string | null;
  /** Whether the answered message was ours or theirs. */
  readonly parentDirection: MessageDirection | null;
  /** Carries replyToPlatformMessageId and replyIsSelfReply. */
  readonly metadata: Record<string, unknown>;
  readonly platformSentAt: Date | null;
  readonly createdAt: Date;
  readonly customerId: number | null;
  readonly sentByEmployeeId: number | null;
  /**
   * WHO on the team sent it, joined rather than looked up per row.
   *
   * The thread used to hand the client `sentByEmployeeId` — an internal bigint —
   * which is both a leak and useless: a client cannot turn it into a name.
   */
  readonly sentByRefId: string | null;
  readonly sentByName: string | null;
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
          platform_message_id, message_kind, body, platform_sent_at, parent_message_id, status,
          has_attachments, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
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
        input.hasAttachments ?? false,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const row = rows[0];
    return row ? { id: row.id, refId: row.ref_id } : null;
  }

  /**
   * Links replies that were stored before the message they answer.
   *
   * ORDER IS NOT GUARANTEED and cannot be. Meta returns a thread NEWEST FIRST,
   * so a bulk recovery projects every reply before its parent — and a reply can
   * also arrive live, days before the delivery it answers is recovered. Both
   * leave a message whose parent we do hold, recorded as one we do not.
   *
   * So resolution happens from both ends: the child looks for its parent when
   * it is stored, and a parent claims the children waiting for it. The platform
   * id kept in metadata is what makes the second direction possible.
   */
  async adoptOrphanReplies(
    enterpriseId: number,
    parentId: number,
    parentPlatformMessageId: string,
  ): Promise<number> {
    const { affected } = await this.mutate(
      `UPDATE messages
          SET parent_message_id = $2, updated_at = now()
        WHERE enterprise_id = $1
          AND parent_message_id IS NULL
          AND is_deleted = false
          AND metadata->>'replyToPlatformMessageId' = $3
          AND id <> $2`,
      [this.requireEnterprise(enterpriseId), parentId, parentPlatformMessageId],
    );
    return affected;
  }

  /**
   * Our id for a message the platform names, if we hold it.
   *
   * Two callers, one query. It tells a harmless `message_edit` — Meta sends one
   * a second after most attachments — from the one that means a delivery was
   * lost, and it resolves `reply_to.mid` into the row a reply is answering, so
   * a threaded exchange can be drawn the way the customer sees it rather than
   * as a flat list.
   */
  async findIdByPlatformMessageId(
    enterpriseId: number,
    platformMessageId: string,
  ): Promise<number | null> {
    const rows = await this.query<{ id: number }>(
      `SELECT id FROM messages
        WHERE enterprise_id = $1 AND platform_message_id = $2 AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), platformMessageId],
    );
    return rows[0]?.id ?? null;
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
    enterpriseId: number,
    outboundEventId: number,
    platformMessageId: string | null,
    status: MessageStatus,
  ): Promise<void> {
    await this.mutate(
      /*
       * TENANT-SCOPED, like every other statement in this file. It keyed on
       * outbound_event_id alone, and the database cannot backstop that: the
       * foreign key to outbound_events is single-column, there is no
       * (id, enterprise_id) parent key on it, and messages_outbound_event_idx is
       * not unique. No reachable caller passes a foreign id today — the relay
       * only ever passes a row it just claimed — but "no caller does" is not the
       * same as "no caller can".
       *
       * $3 and $4 are cast explicitly: without the casts Postgres sees $4 used
       * both as a column value and inside a comparison, and fails with
       * "inconsistent types deduced for parameter $4".
       */
      `UPDATE messages
          SET platform_message_id = COALESCE($3::varchar, platform_message_id),
              status = $4::varchar,
              platform_sent_at = CASE WHEN $4::varchar = 'sent'
                                      THEN now() ELSE platform_sent_at END
        WHERE enterprise_id = $1 AND outbound_event_id = $2`,
      [this.requireEnterprise(enterpriseId), outboundEventId, platformMessageId, status],
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
        `AND (COALESCE(m.platform_sent_at, m.created_at), m.id) ` +
        `< ($${params.length - 1}::timestamptz, $${params.length})`;
    }

    return this.query<MessageRow>(
      `SELECT m.id, m.ref_id AS "refId", m.direction, m.body,
              m.message_kind AS "messageKind", m.status,
              m.is_read AS "isRead", m.is_internal_note AS "isInternalNote",
              m.has_attachments AS "hasAttachments",
              m.platform_sent_at AS "platformSentAt", m.created_at AS "createdAt",
              m.customer_id AS "customerId", m.sent_by_employee_id AS "sentByEmployeeId",
              se.ref_id AS "sentByRefId",
              NULLIF(TRIM(CONCAT_WS(' ', si.first_name, si.last_name)), '') AS "sentByName",
              pm.ref_id AS "parentRefId",
              -- Trimmed here rather than in the client: the thread should not
              -- carry a second full copy of a message it may already be showing.
              LEFT(NULLIF(pm.body, ''), 120) AS "parentExcerpt",
              pm.direction AS "parentDirection",
              m.metadata
         FROM messages m
         LEFT JOIN enterprise_employees se ON se.id = m.sent_by_employee_id
                                          AND se.enterprise_id = m.enterprise_id
                                          AND se.is_deleted = false
         LEFT JOIN identities si ON si.id = se.identity_id AND si.is_deleted = false
         LEFT JOIN messages pm ON pm.id = m.parent_message_id
                              AND pm.enterprise_id = m.enterprise_id
                              AND pm.is_deleted = false
        WHERE m.enterprise_id = $1
          AND m.conversation_id = $2
          AND m.is_deleted = false
          ${keyset}
        ORDER BY COALESCE(m.platform_sent_at, m.created_at) DESC, m.id DESC
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

  /**
   * Applies a platform-side change to a message we already hold.
   *
   * Meta sends an edit, a removal or a hide as its own webhook event, and every
   * one of them was ingested and then discarded — so a comment the customer had
   * deleted went on sitting in the inbox, and an agent who hid one saw no change.
   *
   * A removal is a SOFT delete: the thread query filters is_deleted, so the
   * message disappears from the inbox while the record of it having existed —
   * and of us having answered it — survives. Hard-deleting would take the
   * agent's own reply thread with it.
   *
   * Returns false when we hold no such message, which is not an error: it may
   * predate the connection, or have been the business's own, or have been skipped
   * for a reason already recorded.
   */
  async applyPlatformModeration(input: {
    enterpriseId: number;
    platformMessageId: string;
    action: 'edited' | 'removed' | 'hidden' | 'unhidden';
    text: string | null;
  }): Promise<boolean> {
    const { affected } = await this.mutate(
      `UPDATE messages
          SET body = CASE WHEN $3::varchar = 'edited' THEN COALESCE($4::text, body) ELSE body END,
              is_hidden_on_platform = CASE
                WHEN $3::varchar = 'hidden' THEN true
                WHEN $3::varchar = 'unhidden' THEN false
                ELSE is_hidden_on_platform END,
              is_deleted = CASE WHEN $3::varchar = 'removed' THEN true ELSE is_deleted END,
              updated_at = now()
        WHERE enterprise_id = $1 AND platform_message_id = $2
        RETURNING id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.platformMessageId,
        input.action,
        input.text,
      ],
    );
    return affected > 0;
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
