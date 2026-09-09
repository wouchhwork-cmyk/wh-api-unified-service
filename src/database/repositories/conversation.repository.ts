import { Injectable } from '@nestjs/common';
import { ConversationKind, ConversationStatus, Platform, THREAD_KEY_PREFIX } from '@/shared/enums';
import { BaseRepository } from './base.repository';
import { NOTIFY_INBOX_CHANNEL } from '@/shared/constants';

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
  /**
   * What this thread is ABOUT, when the platform will say.
   *
   * A mention needs the post it sits on — its id, permalink, owner and counts —
   * and none of that belongs on any individual message: it describes the thread,
   * and the reply path needs the media id to answer at all.
   */
  readonly contextMetadata?: Record<string, unknown>;
}

export interface ConversationRow {
  readonly id: number;
  readonly refId: string;
  /**
   * A short label for the thread — for a mention or a comment, the customer's
   * own words, trimmed by the projector. Stored since the beginning and never
   * selected, so nothing could show what a thread was actually about.
   */
  readonly subject: string | null;
  /**
   * OUR post, when the comment's media is one of ours. Null for a mention on
   * somebody else's post — and that null is the proof that moderating it would
   * be refused by the platform (docs/platform-limitations.md §1.10).
   */
  readonly postId: number | null;
  readonly channelId: number;
  readonly customerId: number;
  readonly platform: Platform;
  readonly conversationKind: ConversationKind;
  readonly platformThreadId: string;
  /** What the thread is about — the tagged post, for a mention. */
  readonly contextMetadata: Record<string, unknown>;
  readonly status: ConversationStatus;
  readonly unreadCount: number;
  readonly messageCount: number;
  readonly lastMessageAt: Date | null;
  /**
   * When the CUSTOMER last wrote. Distinct from lastMessageAt, which moves when
   * we reply — and a reply must never reopen the messaging window.
   */
  readonly lastInboundAt: Date | null;
  /**
   * Who the conversation is WITH.
   *
   * Joined rather than looked up per row: an inbox of fifty conversations would
   * otherwise be fifty extra queries, and without it the list can only show a
   * kind label — "direct_message" instead of a person.
   */
  readonly customerRefId: string | null;
  readonly customerDisplayName: string | null;
  readonly customerAvatarUrl: string | null;
  /**
   * What the platform said about this person: whether they follow the business,
   * whether they are verified, how many followers. Triage signals, kept on the
   * customer and useless while nothing serves them.
   */
  readonly customerProfile: Record<string, unknown>;
  /**
   * Who is ANSWERING it, joined for the same reason the customer is.
   *
   * Both endpoints for setting this already existed and nothing ever read it
   * back, so every conversation was unassigned forever and the "assigned to me"
   * filter was permanently empty — which is most of what makes a shared inbox
   * shared.
   */
  readonly assignedToEmployeeId: number | null;
  readonly assignedToRefId: string | null;
  readonly assignedToName: string | null;
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

export interface UpsertConversationResult {
  readonly id: number;
  readonly refId: string;
  /** False when the thread already existed and this message joined it. */
  readonly created: boolean;
}

@Injectable()
export class ConversationRepository extends BaseRepository {
  /**
   * What a resync needs to know about a conversation: which channel it belongs
   * to, and WHO it is with as the platform names them.
   *
   * The identifier comes from customer_identifiers rather than by splitting the
   * composed thread key. The key would work — it is `dm:<scoped id>` — but it is
   * OUR construction, and reversing it would silently start returning the wrong
   * thing the day the prefix scheme changes. The identifier row is what the
   * platform actually said.
   */
  async findResyncTarget(
    enterpriseId: number,
    conversationRefId: string,
  ): Promise<{
    id: number;
    channelId: number;
    conversationKind: ConversationKind;
    targetPlatformId: string | null;
  } | null> {
    const rows = await this.query<{
      id: number;
      channelId: number;
      conversationKind: ConversationKind;
      targetPlatformId: string | null;
    }>(
      `SELECT c.id, c.channel_id AS "channelId",
              c.conversation_kind AS "conversationKind",
              ci.identifier_value AS "targetPlatformId"
         FROM conversations c
         LEFT JOIN customer_identifiers ci ON ci.id = c.customer_identifier_id
                                          AND ci.enterprise_id = c.enterprise_id
                                          AND ci.is_deleted = false
        WHERE c.enterprise_id = $1 AND c.ref_id = $2 AND c.is_deleted = false`,
      [this.requireEnterprise(enterpriseId), conversationRefId],
    );
    return rows[0] ?? null;
  }

  /**
   * Finds or creates the thread. The conflict target is
   * conversations_thread_uniq (channel_id, platform_thread_id), which has NO
   * is_deleted predicate: an archived-then-revived thread must reattach rather
   * than fork.
   */
  async upsert(input: UpsertConversationInput): Promise<UpsertConversationResult> {
    const { rows } = await this.mutate<{ id: number; ref_id: string; created: boolean }>(
      `INSERT INTO conversations
         (enterprise_id, channel_id, customer_id, customer_identifier_id, post_id, platform,
          conversation_kind, platform_thread_id, subject, status, context_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (channel_id, platform_thread_id)
       DO UPDATE SET
         -- Reviving a closed thread reopens it; a new message means it needs
         -- attention again.
         status     = CASE WHEN conversations.status IN ('resolved','closed','archived')
                           THEN $10 ELSE conversations.status END,
         subject    = COALESCE(EXCLUDED.subject, conversations.subject),
         post_id    = COALESCE(EXCLUDED.post_id, conversations.post_id),
         /*
          * MERGED, not replaced. A later event on the same thread may resolve
          * less than the first did — a refused count, a permalink we could not
          * read this time — and overwriting would erase what we already knew.
          * Newer non-null facts win; everything else survives.
          */
         context_metadata = conversations.context_metadata || EXCLUDED.context_metadata,
         is_deleted = false
       /*
        * WHETHER THIS ROW IS NEW, which an upsert otherwise hides. xmax is 0 on
        * a genuine insert and non-zero when the conflict branch updated an
        * existing row — the only way Postgres will tell you, since RETURNING
        * looks identical either way. Callers need it to keep per-customer
        * counters honest without a second round trip to ask.
        */
       RETURNING id, ref_id, (xmax = 0) AS created`,
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
        JSON.stringify(input.contextMetadata ?? {}),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('conversations upsert returned no row');

    /*
     * customers.conversation_count is maintained HERE rather than left to every
     * caller, because there are three of them — two projectors and the backfill
     * — and a counter that any one of them can forget is a counter that lies.
     * It was declared DEFAULT 0 and never written to at all, so it read 0 for
     * every customer who had ever had a conversation.
     */
    if (row.created) {
      await this.mutate(
        `UPDATE customers
            SET conversation_count = conversation_count + 1, updated_at = now()
          WHERE id = $1 AND enterprise_id = $2`,
        [input.customerId, this.requireEnterprise(input.enterpriseId)],
      );
    }

    return { id: row.id, refId: row.ref_id, created: row.created };
  }

  async findByRefId(enterpriseId: number, refId: string): Promise<ConversationRow | null> {
    const rows = await this.query<ConversationRow>(
      `SELECT cv.id, cv.ref_id AS "refId", cv.channel_id AS "channelId",
              cv.customer_id AS "customerId", cv.platform,
              cv.conversation_kind AS "conversationKind",
              cv.platform_thread_id AS "platformThreadId", cv.status, cv.subject,
              cv.post_id AS "postId",
              cv.context_metadata AS "contextMetadata",
              cv.unread_count AS "unreadCount", cv.message_count AS "messageCount",
              cv.last_message_at AS "lastMessageAt", cv.last_inbound_at AS "lastInboundAt",
              cu.ref_id AS "customerRefId", cu.display_name AS "customerDisplayName",
              cu.avatar_url AS "customerAvatarUrl",
              cu.metadata AS "customerProfile",
              cv.assigned_to_employee_id AS "assignedToEmployeeId",
              ae.ref_id AS "assignedToRefId",
              /*
               * NULLIF, because CONCAT_WS returns an empty STRING when every
               * argument is null — so an unassigned conversation reported a name
               * of '' rather than nothing, and so would one assigned to somebody
               * whose name we have never learned. Both mean "no name".
               */
              NULLIF(TRIM(CONCAT_WS(' ', ai.first_name, ai.last_name)), '') AS "assignedToName"
         FROM conversations cv
         LEFT JOIN customers cu ON cu.id = cv.customer_id
                               AND cu.enterprise_id = cv.enterprise_id
         LEFT JOIN enterprise_employees ae ON ae.id = cv.assigned_to_employee_id
                                        AND ae.enterprise_id = cv.enterprise_id
                                        AND ae.is_deleted = false
         LEFT JOIN identities ai ON ai.id = ae.identity_id AND ai.is_deleted = false
        WHERE cv.enterprise_id = $1 AND cv.ref_id = $2 AND cv.is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), refId],
    );
    return rows[0] ?? null;
  }

  /**
   * The inbox list. Keyset pagination on exactly the columns
   * conversations_inbox_idx is built on, with id as the stable tiebreaker.
   */
  /**
   * The mention conversation that IS a given comment, when we hold it.
   *
   * A mention placed in a reply keeps the id of the comment it answered. When
   * that comment also tagged us, it is already a conversation here — so the two
   * are the same exchange filed twice, and this is what turns a duplicated
   * excerpt into a link an agent can follow.
   *
   * Returns null for the ordinary case: the parent belonged to somebody else,
   * and Meta will not describe a stranger's comment at all
   * (docs/platform-limitations.md §1.9).
   *
   * Served by `conversations_mention_comment_idx`, an expression index over the
   * jsonb key — without it this is a sequential scan on a thread read.
   */
  async findMentionByCommentId(
    enterpriseId: number,
    commentId: string,
  ): Promise<{ refId: string; subject: string | null } | null> {
    const rows = await this.query<{ refId: string; subject: string | null }>(
      `SELECT ref_id AS "refId", subject
         FROM conversations
        WHERE enterprise_id = $1
          AND conversation_kind = $2
          AND context_metadata->>'mentionedCommentId' = $3
          AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), ConversationKind.Mention, commentId],
    );
    return rows[0] ?? null;
  }

  async listInbox(input: {
    enterpriseId: number;
    status: ConversationStatus | null;
    assignedToEmployeeId: number | null;
    /** Narrow to one kind of thread — mentions, comments, DMs. Null means all. */
    conversationKind: ConversationKind | null;
    limit: number;
    cursor: { lastMessageAt: Date | null; id: number } | null;
  }): Promise<ConversationRow[]> {
    const params: unknown[] = [this.requireEnterprise(input.enterpriseId), input.limit];
    const filters: string[] = [];

    /*
     * EVERY column is qualified, because the customers join makes `id`,
     * `ref_id`, `status` and `is_deleted` ambiguous — customers has all four.
     * Unqualified, this query does not fail a type check, it fails at runtime.
     */
    if (input.status) {
      params.push(input.status);
      filters.push(`AND cv.status = $${params.length}`);
    }
    if (input.assignedToEmployeeId !== null) {
      params.push(input.assignedToEmployeeId);
      filters.push(`AND cv.assigned_to_employee_id = $${params.length}`);
    }
    /*
     * Parameterised like every other filter — the value is a validated enum at
     * the edge, and interpolating it anyway would be the one place in this file
     * where a query is built from a string.
     */
    if (input.conversationKind !== null) {
      params.push(input.conversationKind);
      filters.push(`AND cv.conversation_kind = $${params.length}`);
    }
    if (input.cursor) {
      params.push(input.cursor.lastMessageAt, input.cursor.id);
      const at = `$${params.length - 1}::timestamptz`;
      const id = `$${params.length}`;
      /*
       * The null case is handled EXPLICITLY, for the same reason it is in
       * customer.repository.ts and post.repository.ts: row comparison against
       * NULL yields NULL, so the bare `(last_message_at, id) < ($n, $m)` form
       * silently dropped every conversation with no messages yet — exactly the
       * rows ORDER BY ... NULLS LAST puts at the end — from page two onward.
       * last_message_at is nullable, and a conversation created by an upsert
       * whose message then lost the dedup race really does keep it null.
       */
      filters.push(
        `AND (
             (${at} IS NOT NULL AND cv.last_message_at IS NOT NULL
                AND (cv.last_message_at, cv.id) < (${at}, ${id}))
          OR (${at} IS NOT NULL AND cv.last_message_at IS NULL)
          OR (${at} IS NULL AND cv.last_message_at IS NULL AND cv.id < ${id})
        )`,
      );
    }

    return this.query<ConversationRow>(
      `SELECT cv.id, cv.ref_id AS "refId", cv.channel_id AS "channelId",
              cv.customer_id AS "customerId", cv.platform,
              cv.conversation_kind AS "conversationKind",
              cv.platform_thread_id AS "platformThreadId", cv.status, cv.subject,
              cv.post_id AS "postId",
              cv.context_metadata AS "contextMetadata",
              cv.unread_count AS "unreadCount", cv.message_count AS "messageCount",
              cv.last_message_at AS "lastMessageAt", cv.last_inbound_at AS "lastInboundAt",
              cu.ref_id AS "customerRefId", cu.display_name AS "customerDisplayName",
              cu.avatar_url AS "customerAvatarUrl",
              cu.metadata AS "customerProfile",
              cv.assigned_to_employee_id AS "assignedToEmployeeId",
              ae.ref_id AS "assignedToRefId",
              /*
               * NULLIF, because CONCAT_WS returns an empty STRING when every
               * argument is null — so an unassigned conversation reported a name
               * of '' rather than nothing, and so would one assigned to somebody
               * whose name we have never learned. Both mean "no name".
               */
              NULLIF(TRIM(CONCAT_WS(' ', ai.first_name, ai.last_name)), '') AS "assignedToName"
         FROM conversations cv
         LEFT JOIN customers cu ON cu.id = cv.customer_id
                               AND cu.enterprise_id = cv.enterprise_id
         LEFT JOIN enterprise_employees ae ON ae.id = cv.assigned_to_employee_id
                                        AND ae.enterprise_id = cv.enterprise_id
                                        AND ae.is_deleted = false
         LEFT JOIN identities ai ON ai.id = ae.identity_id AND ai.is_deleted = false
        WHERE cv.enterprise_id = $1
          AND cv.is_deleted = false
          ${filters.join('\n          ')}
        ORDER BY cv.last_message_at DESC NULLS LAST, cv.id DESC
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
              /*
               * GREATEST here too, and for the same reason it guards
               * last_message_at: backfill appends HISTORIC messages at low
               * priority, so a webhook from a minute ago is projected before a
               * message from last year and the plain assignment rewound this
               * column. That rewind is not cosmetic — evaluateReplyWindow reads
               * it, so a rewind reports the 24-hour window as long closed on a
               * conversation the platform would still accept a reply to.
               */
              last_inbound_at    = CASE WHEN $3 = 1
                                        THEN GREATEST(COALESCE(last_inbound_at, $4), $4)
                                        ELSE last_inbound_at END,
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
    employeeId: number | null,
  ): Promise<void> {
    await this.mutate(
      // Cast for the same reason as setStatus: $3 is both a column value and a
      // comparison operand, and leaving it to inference is how that endpoint
      // came to return 500 for its whole life.
      `UPDATE conversations
          SET assigned_to_employee_id = $3::bigint,
              assigned_at = CASE WHEN $3::bigint IS NULL THEN NULL ELSE now() END
        WHERE id = $2 AND enterprise_id = $1 AND is_deleted = false`,
      [this.requireEnterprise(enterpriseId), conversationId, employeeId],
    );
  }

  async setStatus(
    enterpriseId: number,
    conversationId: number,
    status: ConversationStatus,
  ): Promise<void> {
    await this.mutate(
      /*
       * $3 IS CAST EXPLICITLY, twice.
       *
       * Without the casts Postgres sees the same parameter used both as a column
       * value and inside a comparison against string literals, and refuses the
       * whole statement with "inconsistent types deduced for parameter $3". This
       * endpoint therefore answered 500 for every request ever made to it — and
       * nothing noticed, because no UI called it and no test covered it. Same
       * trap as messages.recordDelivery, which documents it for the same reason.
       */
      `UPDATE conversations
          SET status = $3::varchar,
              resolved_at = CASE WHEN $3::varchar IN ('resolved','closed')
                                 THEN now() ELSE NULL END
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

  /**
   * Announces that a conversation changed, for the live inbox.
   *
   * Called INSIDE the projection's transaction on purpose: Postgres holds a
   * notification until commit, so a subscriber is never told about a
   * conversation that then rolled back.
   *
   * Ids only — no message text, no customer name. The notification says "look
   * again", and the client looks through the authorised endpoint, which is the
   * only place tenant checks live.
   */
  async notifyChanged(input: {
    enterpriseId: number;
    conversationRefId: string;
    /*
     * WHY it changed. A client re-reads regardless, so this is only a hint —
     * but 'assigned' and 'status' let one decide whether the OPEN thread needs
     * re-rendering or just the list row, and they are what makes a colleague's
     * assignment visible without a reload.
     */
    kind: 'inbound' | 'outbound' | 'assigned' | 'status';
  }): Promise<void> {
    await this.notifyQueue(
      NOTIFY_INBOX_CHANNEL,
      JSON.stringify({
        enterpriseId: input.enterpriseId,
        conversationRefId: input.conversationRefId,
        kind: input.kind,
      }),
    );
  }
}
