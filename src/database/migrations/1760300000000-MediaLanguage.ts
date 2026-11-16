import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What language the media was in.
 *
 * A VOICE NOTE IS NOT A LANGUAGE-NEUTRAL OBJECT. Somebody who speaks Hindi
 * into their phone and types nothing has told us what language to answer in,
 * and until now that was the one thing the description threw away: the model
 * wrote an English summary of Hindi speech, the assistant read English, and
 * a customer who had never typed a word of it got answered in English.
 *
 * Nullable with no default and no backfill. Descriptions written before this
 * column existed genuinely do not know, and NULL is how a reader tells that
 * apart from media with nothing spoken in it.
 */
export class MediaLanguage1760300000000 implements MigrationInterface {
  name = 'MediaLanguage1760300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE media_analyses ADD COLUMN IF NOT EXISTS language varchar(40)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE media_analyses DROP COLUMN IF EXISTS language`);
  }
}
