import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What it takes to rebuild a prompt without having kept one.
 *
 * "Why did it say that?" is unanswerable without the prompt, and keeping the
 * prompt means keeping a second copy of every customer conversation — their
 * words, their name, the transcript of their voice note, and the business's
 * own contact details. That is not a debug field, it is a data store, and it
 * would quietly accumulate for ever.
 *
 * So the prompt is made RECONSTRUCTIBLE instead of stored. Almost everything
 * in it is already deterministic: the role, the rules and the output
 * contract are code; the business instructions are a version number; the
 * context comes from rows; and the turns are now tagged with the ids of the
 * messages they came from. Recording which messages were shown is the last
 * missing piece.
 *
 * THE HASH IS WHAT MAKES IT HONEST. Rebuilding gives you the prompt as it
 * would be built NOW — a profile edited since, a photo described again, a
 * console prompt rewritten, and the reconstruction quietly diverges from
 * what actually ran. Hashing the real one at the time costs 64 characters
 * and turns "here is roughly what it saw" into a claim that can be checked:
 * rebuild, hash, compare. Equal means exact. Different means something
 * underneath moved, and the reconstruction is a lead rather than evidence.
 *
 * `ref_id` so a call can be named in an API without exposing a row id.
 */
export class ModelCallPromptRecipe1760700000000 implements MigrationInterface {
  name = 'ModelCallPromptRecipe1760700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE model_calls
        ADD COLUMN IF NOT EXISTS ref_id      uuid NOT NULL DEFAULT gen_random_uuid(),
        ADD COLUMN IF NOT EXISTS prompt_hash varchar(64),
        ADD COLUMN IF NOT EXISTS turn_refs   jsonb
    `);

    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS model_calls_ref_uniq ON model_calls (ref_id)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS model_calls_ref_uniq`);
    await q.query(`
      ALTER TABLE model_calls
        DROP COLUMN IF EXISTS ref_id,
        DROP COLUMN IF EXISTS prompt_hash,
        DROP COLUMN IF EXISTS turn_refs
    `);
  }
}
