import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marks comments that already arrived carrying no text.
 *
 * Instagram OMITS `text` when a comment is a GIF, a sticker or a photo — it
 * does not send it empty — and exposes no field for the media on any post, our
 * own included, at every API version. That absence is the only signal, and the
 * projector records it as `platformSentNoText`. Comments projected BEFORE that
 * existed have no marker, so the inbox draws them as a blank line, which reads
 * as somebody having sent nothing.
 *
 * NOT A GUESS. The evidence is the ledger row that produced each message: if
 * the webhook payload had no `text` key, the comment had no text. Nothing is
 * inferred from an empty body, which would wrongly catch a comment somebody
 * really did leave empty — a different fact, and one the projector is careful
 * to distinguish.
 *
 * Idempotent, and scoped so it cannot touch anything else: a repaired row gains
 * the key and immediately stops matching, only Instagram COMMENT events are
 * considered, and the metadata is merged rather than replaced so nothing
 * already stored is lost.
 */
export class MarkTextlessComments1757500000000 implements MigrationInterface {
  name = 'MarkTextlessComments1757500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE messages m
         SET metadata = m.metadata || '{"platformSentNoText": true}'::jsonb,
             updated_at = now()
        FROM inbound_events e
       WHERE e.id = m.inbound_event_id
         AND e.event_type = 'comment'
         AND e.platform = 'instagram'
         AND e.payload ? 'value'
         AND NOT (e.payload->'value' ? 'text')
         AND NOT (m.metadata ? 'platformSentNoText')
         AND m.is_deleted = false
    `);
  }

  /**
   * Removes only the key this added. The rest of the metadata is somebody
   * else's, so `down` cannot simply reset it.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE messages m
         SET metadata = m.metadata - 'platformSentNoText'
        FROM inbound_events e
       WHERE e.id = m.inbound_event_id
         AND e.event_type = 'comment'
         AND e.platform = 'instagram'
         AND m.metadata ? 'platformSentNoText'
    `);
  }
}
