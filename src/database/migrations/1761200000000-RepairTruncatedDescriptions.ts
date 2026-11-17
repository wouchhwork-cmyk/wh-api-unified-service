import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Descriptions that kept the envelope instead of what was in it.
 *
 * The analysis cap is counted in tokens, so a long transcript stopped
 * mid-string: the JSON never closed, the reader could not parse it, and the
 * fallback kept the whole raw blob AS the summary. Those rows read
 * `{"summary": "A wedding video…", "transcript":` wherever a description is
 * shown — the inbox, the assistant's prompt, anything asking what a photo
 * was. The transcript is in there too, trapped inside a string nobody
 * unpacked.
 *
 * The reader salvages this shape now, but only for descriptions written
 * from here on. These are already stored, and the fields are plainly
 * visible in them, so they are pulled apart in place rather than left as
 * the one kind of description that shows its own plumbing.
 *
 * TOUCHES ONLY WHAT IS UNAMBIGUOUS: a summary that begins with a brace and
 * carries a "summary" key. Anything else is a description that genuinely
 * starts with punctuation, and rewriting it would be inventing.
 */
export class RepairTruncatedDescriptions1761200000000 implements MigrationInterface {
  name = 'RepairTruncatedDescriptions1761200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE media_analyses
         SET summary = NULLIF(trim(substring(summary from '"summary"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)')), ''),
             transcript = COALESCE(
               transcript,
               NULLIF(trim(substring(summary from '"transcript"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)')), '')
             ),
             updated_at = now()
       WHERE summary LIKE '{%'
         AND summary LIKE '%"summary"%'
    `);
  }

  public async down(): Promise<void> {
    /*
     * NOTHING. The envelope is not worth putting back: what it held is now
     * in the columns it was holding them for, and restoring it would mean
     * re-wrapping readable text in broken JSON.
     */
  }
}
