import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tells what a model HEARD apart from what it READ.
 *
 * There was one `transcript` column holding "everything said or written",
 * and a model asked for one field merges the two every time — for it they
 * are both just words it extracted. Observed on a live wedding invitation
 * video: every line of its printed text came back filed under "Background:",
 * the slot meant for sound behind the speech. So the inbox, the assistant's
 * prompt and anything else reading that row were told the venue and the date
 * were things somebody had SAID.
 *
 * That distinction is not cosmetic. "They told me the date" and "the date is
 * printed on the card they sent" lead to different replies, and only one of
 * them is true.
 *
 * `scenes` is the third of the set and the one that makes a video legible
 * rather than merely transcribed: one line per shot, tying what is seen to
 * what is written on screen to what is heard at that moment. Null for a
 * still image, where there is nothing to walk through.
 *
 * EXPAND ONLY. Both columns are nullable and nothing is backfilled — the
 * media these rows describe is long gone, so there is nothing to re-read,
 * and every existing row keeps exactly what it had. A description written
 * before today simply has no visible_text, which is the honest answer: we
 * never asked that question of it.
 */
export class MediaHeardAndRead1761300000000 implements MigrationInterface {
  name = 'MediaHeardAndRead1761300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE media_analyses ADD COLUMN IF NOT EXISTS visible_text text`);
    await q.query(`ALTER TABLE media_analyses ADD COLUMN IF NOT EXISTS scenes text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE media_analyses DROP COLUMN IF EXISTS scenes`);
    await q.query(`ALTER TABLE media_analyses DROP COLUMN IF EXISTS visible_text`);
  }
}
