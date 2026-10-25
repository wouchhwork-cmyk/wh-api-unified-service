import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An award says which PROGRAM VERSION decided it, not just which rule version.
 *
 * `reward_awards` already carried `rule_version`, and `reward_rules` are
 * versioned and never edited in place — so "which rule decided this" has
 * always been answerable. The programme around the rule was not: a programme
 * can be renamed, rescheduled, or have its whole rule set replaced, and an
 * award made before any of that pointed only at the programme's CURRENT shape.
 * "Why did this customer get 20 points in March" was answerable down to the
 * rule and not up to the programme that authorised it.
 *
 * TWO COLUMNS, and the first is the one that makes the second cheap.
 *
 * `reward_programs.version` mirrors the counter `entity_versions` already
 * keeps. Deriving it at award time would mean a MAX() against the version
 * history on the hot path, per award — and the evaluator has already loaded
 * the programme row for its timezone, so reading one more column off it costs
 * nothing. The mirror is written in the SAME TRANSACTION as the version row it
 * mirrors; `entity_versions` stays the authority, this is the fast path.
 *
 * `reward_awards.program_version` IS NULLABLE, and stays nullable.
 *
 * Every award that already exists was decided by a programme whose version we
 * do not know — the version history only began when `entity_versions` did.
 * Backfilling 1 would state, in a column built to be trusted, that each of
 * them was decided by the first version of its programme. NULL says "before
 * this was recorded", which is the truth and is distinguishable from it.
 */
export class AwardsRecordTheProgramVersion1759300000000 implements MigrationInterface {
  name = 'AwardsRecordTheProgramVersion1759300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE reward_programs
        ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1
    `);

    /*
     * Programmes that already have a version history take its highest number,
     * so the mirror starts in step with what it mirrors rather than claiming
     * every programme is on version 1. A programme with no history keeps the
     * default — it has been through no recorded edit, which IS version 1.
     */
    await q.query(`
      UPDATE reward_programs p
         SET version = v.highest
        FROM (
          SELECT entity_id, MAX(version) AS highest
            FROM entity_versions
           WHERE entity_type = 'reward_program'
           GROUP BY entity_id
        ) v
       WHERE v.entity_id = p.id
         AND v.highest > p.version
    `);

    await q.query(`
      ALTER TABLE reward_awards
        ADD COLUMN IF NOT EXISTS program_version INTEGER
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE reward_awards DROP COLUMN IF EXISTS program_version`);
    await q.query(`ALTER TABLE reward_programs DROP COLUMN IF EXISTS version`);
  }
}
