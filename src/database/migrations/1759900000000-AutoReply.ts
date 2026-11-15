import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The switch that lets the assistant answer a customer by itself.
 *
 * TWO SWITCHES, AND BOTH MUST BE ON. This column is the business's own
 * consent — it is their customers and their name on the reply. The platform
 * setting beside it is ours, and exists so that a problem with the assistant
 * can be stopped everywhere in one edit rather than business by business.
 *
 * DEFAULT FALSE, and no backfill. Every business that existed before this
 * column keeps answering its own customers, which is what they agreed to. An
 * automation that arrives switched on is one nobody chose.
 */
export class AutoReply1759900000000 implements MigrationInterface {
  name = 'AutoReply1759900000000';

  public async up(q: QueryRunner): Promise<void> {
    /*
     * NOT NULL with a default, which is safe to add online in Postgres 11+:
     * the default is recorded in the catalogue rather than rewritten into
     * every existing row.
     */
    await q.query(`
      ALTER TABLE enterprises
        ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN NOT NULL DEFAULT false
    `);

    /*
     * The platform's own switch, added to the row the chat console already
     * edits. Written only where it is missing, so a deploy cannot turn off an
     * assistant somebody deliberately turned on.
     */
    await q.query(`
      UPDATE platform_settings
         SET value = value || '{"autoReply": false}'::jsonb
       WHERE key = 'chat' AND value->>'autoReply' IS NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE enterprises DROP COLUMN IF EXISTS auto_reply_enabled`);
    await q.query(`UPDATE platform_settings SET value = value - 'autoReply' WHERE key = 'chat'`);
  }
}
