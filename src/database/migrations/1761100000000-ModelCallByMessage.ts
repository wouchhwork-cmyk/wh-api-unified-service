import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Finding the call that answered a message.
 *
 * A reply records the id of the call that wrote it — but only since calls
 * started being recorded on the message, which is recent. Everything before
 * that still HAS a model call: it names the inbound message it answered, and
 * the reply's own metadata records the same id. The two join up, and the
 * button that rebuilds a prompt works on older replies instead of being dead
 * on all of them.
 *
 * That join runs on every thread read, so it needs an index or it is a
 * sequential scan over every model call this business has ever made, once
 * per conversation opened.
 *
 * Partial: a media description answers no message, and indexing its null
 * would be indexing the majority to find the minority.
 */
export class ModelCallByMessage1761100000000 implements MigrationInterface {
  name = 'ModelCallByMessage1761100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS model_calls_message_idx
      ON model_calls (enterprise_id, message_id, created_at DESC)
      WHERE message_id IS NOT NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS model_calls_message_idx`);
  }
}
