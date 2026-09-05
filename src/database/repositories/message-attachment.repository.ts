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
}
