import { Injectable } from '@nestjs/common';
import { ConversationKind, ConversationStatus, Platform, THREAD_KEY_PREFIX } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface UpsertConversationInput {
  readonly enterpriseId: number;
  readonly channelId: number;
  readonly customerId: number;
  readonly customerIdentifierId: number | null;
  readonly postId: number | null;
  readonly platform: Platform;
  readonly conversationKind: ConversationKind;
  /** The derived thread key, ALWAYS prefixed by kind. */
  readonly platformThreadId: string;
  readonly subject: string | null;
}

export interface ConversationRow {
  readonly id: number;
  readonly refId: string;
  readonly channelId: number;
  readonly customerId: number;
  readonly platform: Platform;
  readonly conversationKind: ConversationKind;
  readonly platformThreadId: string;
  readonly status: ConversationStatus;
  readonly unreadCount: number;
  readonly messageCount: number;
  readonly lastMessageAt: Date | null;
}

/**
 * Composes a thread key.
 *
 * Meta has no thread object for comments, so the key is DERIVED and prefixed by
 * kind — which is what makes conversations_thread_uniq able to dedup at all, and
 * what stops two id spaces colliding. One conversation per top-level comment
 * thread, not per post: a busy post would otherwise be a single thread holding
 * hundreds of unrelated exchanges, impossible to assign or resolve.
 */
export function composeThreadKey(kind: ConversationKind, platformId: string): string {
  return `${THREAD_KEY_PREFIX[kind]}:${platformId}`;
}

@Injectable()
export class ConversationRepository extends BaseRepository {
  /**
   * Finds or creates the thread. The conflict target is
   * conversations_thread_uniq (channel_id, platform_thread_id), which has NO
   * is_deleted predicate: an archived-then-revived thread must reattach rather
   * than fork.
   */
  async upsert(input: UpsertConversationInput): Promise<{ id: number; refId: string }> {
    const { rows } = await this.mutate<{ id: number; ref_id: string }>(
      `INSERT INTO conversations
         (enterprise_id, channel_id, customer_id, customer_identifier_id, post_id, platform,
          conversation_kind, platform_thread_id, subject, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (channel_id, platform_thread_id)
       DO UPDATE SET
         -- Reviving a closed thread reopens it; a new message means it needs
         -- attention again.
         status     = CASE WHEN conversations.status IN ('resolved','closed','archived')
                           THEN $10 ELSE conversations.status END,
         subject    = COALESCE(EXCLUDED.subject, conversations.subject),
         post_id    = COALESCE(EXCLUDED.post_id, conversations.post_id),
         is_deleted = false
       RETURNING id, ref_id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.channelId,
        input.customerId,
        input.customerIdentifierId,
        input.postId,
        input.platform,
        input.conversationKind,
        input.platformThreadId,
        input.subject,
        ConversationStatus.Open,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('conversations upsert returned no row');
    return { id: row.id, refId: row.ref_id };
  }

  async findByRefId(enterpriseId: number, refId: string): Promise<ConversationRow | null> {
    const rows = await this.query<ConversationRow>(
      `SELECT id, ref_id AS "refId", channel_id AS "channelId", customer_id AS "customerId",
              platform, conversation_kind AS "conversationKind",
              platform_thread_id AS "platformThreadId", status,
              unread_count AS "unreadCount", message_count AS "messageCount",
              last_message_at AS "lastMessageAt"
         FROM conversations
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), refId],
    );
    return rows[0] ?? null;
  }

  /**
   * The inbox list. Keyset pagination on exactly the columns
   * conversations_inbox_idx is built on, with id as the stable tiebreaker.
   */
  async listInbox(input: {
    enterpriseId: number;
    status: ConversationStatus | null;
    assignedToMemberId: number | null;
    limit: number;
    cursor: { lastMessageAt: Date | null; id: number } | null;
  }): Promise<ConversationRow[]> {
    const params: unknown[] = [this.requireEnterprise(input.enterpriseId), input.limit];
    const filters: string[] = [];

    if (input.status) {
      params.push(input.status);
      filters.push(`AND status = $${params.length}`);
    }
    if (input.assignedToMemberId !== null) {
      params.push(input.assignedToMemberId);
      filters.push(`AND assigned_to_member_id = $${params.length}`);
    }
    if (input.cursor) {
      params.push(input.cursor.lastMessageAt, input.cursor.id);
      filters.push(`AND (last_message_at, id) < ($${params.length - 1}, $${params.length})`);
    }

    return this.query<ConversationRow>(
      `SELECT id, ref_id AS "refId", channel_id AS "channelId", customer_id AS "customerId",
              platform, conversation_kind AS "conversationKind",
              platform_thread_id AS "platformThreadId", status,
              unread_count AS "unreadCount", message_count AS "messageCount",
              last_message_at AS "lastMessageAt"
         FROM conversations
        WHERE enterprise_id = $1
          AND is_deleted = false
          ${filters.join('\n          ')}
        ORDER BY last_message_at DESC NULLS LAST, id DESC
        LIMIT $2`,
      params,
    );
  }

  /**
   * Maintains the denormalised counters the inbox list renders from.
   *
   * first_responded_at is set only once, by COALESCE: it feeds response-time
   * reporting, and overwriting it on every reply would make that meaningless.
   */
  async recordMessage(input: {
    enterpriseId: number;
    conversationId: number;
    inbound: boolean;
    occurredAt: Date;
  }): Promise<void> {
    await this.mutate(
      `UPDATE conversations
          SET message_count      = message_count + 1,
              unread_count       = unread_count + $3,
              last_message_at    = GREATEST(COALESCE(last_message_at, $4), $4),
              last_inbound_at    = CASE WHEN $3 = 1 THEN $4 ELSE last_inbound_at END,
              first_responded_at = CASE WHEN $3 = 0
                                        THEN COALESCE(first_responded_at, $4)
                                        ELSE first_responded_at END
        WHERE id = $2 AND enterprise_id = $1`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.conversationId,
        input.inbound ? 1 : 0,
        input.occurredAt,
      ],
    );
  }

  async assign(
    enterpriseId: number,
    conversationId: number,
    memberId: number | null,
  ): Promise<void> {
    await this.mutate(
      `UPDATE conversations
          SET assigned_to_member_id = $3,
              assigned_at = CASE WHEN $3 IS NULL THEN NULL ELSE now() END
        WHERE id = $2 AND enterprise_id = $1 AND is_deleted = false`,
      [this.requireEnterprise(enterpriseId), conversationId, memberId],
    );
  }

  async setStatus(
    enterpriseId: number,
    conversationId: number,
    status: ConversationStatus,
  ): Promise<void> {
    await this.mutate(
      `UPDATE conversations
          SET status = $3,
              resolved_at = CASE WHEN $3 IN ('resolved','closed') THEN now() ELSE NULL END
        WHERE id = $2 AND enterprise_id = $1 AND is_deleted = false`,
      [this.requireEnterprise(enterpriseId), conversationId, status],
    );
  }

  /** Clearing the badge is a write, so it is explicit rather than a read side effect. */
  async markRead(enterpriseId: number, conversationId: number): Promise<void> {
    await this.mutate(
      `UPDATE conversations SET unread_count = 0 WHERE id = $2 AND enterprise_id = $1`,
      [this.requireEnterprise(enterpriseId), conversationId],
    );
    await this.mutate(
      `UPDATE messages SET is_read = true
        WHERE enterprise_id = $1 AND conversation_id = $2
          AND direction = 'inbound' AND is_read = false AND is_deleted = false`,
      [enterpriseId, conversationId],
    );
  }
}
