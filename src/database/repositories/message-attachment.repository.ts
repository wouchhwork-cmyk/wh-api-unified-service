import { Injectable } from '@nestjs/common';
import { AttachmentStatus, MediaKind } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface InsertAttachmentInput {
  readonly enterpriseId: number;
  readonly messageId: number;
  readonly mediaKind: MediaKind;
  readonly sourceUrl: string | null;
  readonly sortOrder: number;
  readonly metadata: Record<string, unknown>;
}

export interface AttachmentRow {
  readonly messageId: number;
  readonly mediaKind: MediaKind;
  readonly sourceUrl: string | null;
  readonly storageKey: string | null;
  readonly sortOrder: number;
  readonly status: AttachmentStatus;
  readonly metadata: Record<string, unknown>;
}

/**
 * Media on a message.
 *
 * The table has existed since the schema was written and had never been
 * inserted into — every attachment a webhook delivered was dropped on the floor,
 * which for a story mention meant dropping the whole message.
 */
@Injectable()
export class MessageAttachmentRepository extends BaseRepository {
  /**
   * Writes a message's attachments in ONE statement.
   *
   * One round trip rather than one per attachment: a carousel is a handful of
   * rows and this runs inside the projection transaction, which is held open
   * while it does.
   */
  async insertMany(inputs: readonly InsertAttachmentInput[]): Promise<number> {
    if (inputs.length === 0) return 0;

    const params: unknown[] = [];
    const tuples = inputs.map((input) => {
      params.push(
        this.requireEnterprise(input.enterpriseId),
        input.messageId,
        input.mediaKind,
        input.sourceUrl,
        input.sortOrder,
        JSON.stringify(input.metadata),
      );
      const base = params.length - 6;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb)`;
    });

    const { rows } = await this.mutate<{ id: number }>(
      `INSERT INTO message_attachments
         (enterprise_id, message_id, media_kind, source_url, sort_order, metadata)
       VALUES ${tuples.join(', ')}
       RETURNING id`,
      params,
    );
    return rows.length;
  }

  /**
   * Attachments for a page of thread messages, in one query.
   *
   * Takes every message id at once because the alternative is a query per
   * message — the N+1 the thread endpoint would otherwise acquire the moment it
   * started returning media.
   */
  async listForMessages(
    enterpriseId: number,
    messageIds: readonly number[],
  ): Promise<AttachmentRow[]> {
    if (messageIds.length === 0) return [];

    return this.query<AttachmentRow>(
      `SELECT message_id AS "messageId", media_kind AS "mediaKind",
              source_url AS "sourceUrl", storage_key AS "storageKey",
              sort_order AS "sortOrder", status, metadata
         FROM message_attachments
        WHERE enterprise_id = $1
          AND message_id = ANY($2::bigint[])
          AND is_deleted = false
        ORDER BY message_id, sort_order, id`,
      [this.requireEnterprise(enterpriseId), messageIds],
    );
  }
  /**
   * The attachments in one conversation whose links can expire, with the
   * platform message id they hang off.
   *
   * ONLY THE EXPIRING ONES. A share is an instagram.com permalink and a GIF
   * comes from Giphy; both are permanent, and including them would shift the
   * positions the refresh matches on — it zips our rows against the fresh links
   * in order, so both sides have to be filtered the same way.
   *
   * Ordered by message and then sort_order, which is the order
   * `toWebhookAttachments` produced them in.
   */
  async listRefreshable(
    enterpriseId: number,
    conversationId: number,
  ): Promise<
    { id: number; platformMessageId: string; sortOrder: number; sourceUrl: string }[]
  > {
    return this.query(
      `SELECT a.id,
              m.platform_message_id AS "platformMessageId",
              a.sort_order          AS "sortOrder",
              a.source_url          AS "sourceUrl"
         FROM message_attachments a
         JOIN messages m ON m.id = a.message_id AND m.enterprise_id = a.enterprise_id
        WHERE a.enterprise_id = $1
          AND m.conversation_id = $2
          AND a.source_url IS NOT NULL
          AND m.platform_message_id IS NOT NULL
          AND a.metadata->>'stableUrl' IS DISTINCT FROM 'true'
        ORDER BY m.platform_message_id, a.sort_order`,
      [this.requireEnterprise(enterpriseId), conversationId],
    );
  }

  /**
   * Replaces the links on attachments we already hold.
   *
   * THE ONLY PLACE AN ATTACHMENT IS MUTATED. Everything else about this table
   * is append-only — the projector writes rows for messages it has not seen and
   * never revisits them — which is why a resync could not fix an expired link
   * and this exists instead. Nothing but `source_url` moves: the media kind,
   * the sort order and the metadata describe what was sent, and re-reading the
   * thread is not new information about any of that.
   */
  async refreshSourceUrls(
    enterpriseId: number,
    updates: readonly { id: number; sourceUrl: string }[],
  ): Promise<number> {
    if (updates.length === 0) return 0;

    const ids = updates.map((update) => update.id);
    const urls = updates.map((update) => update.sourceUrl);

    // One statement rather than one per row: a carousel that has expired is
    // several rows, and they belong to the same click.
    const { affected } = await this.mutate(
      `UPDATE message_attachments AS a
          SET source_url = fresh.url, updated_at = now()
         FROM (SELECT unnest($2::bigint[]) AS id, unnest($3::text[]) AS url) AS fresh
        WHERE a.id = fresh.id AND a.enterprise_id = $1`,
      [this.requireEnterprise(enterpriseId), ids, urls],
    );
    return affected;
  }

}
