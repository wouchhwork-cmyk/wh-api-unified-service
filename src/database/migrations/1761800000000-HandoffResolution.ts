import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When a handoff was marked handled, and by whom.
 *
 * WHY ABSENCE WAS NOT ENOUGH. Clearing the flag set `needs_human` false and
 * nulled everything beside it, so "nobody ever needed a person here" and "a
 * colleague came, dealt with it and closed it" became the same row. The
 * assistant was then asked to work out which, from nothing — and it got it
 * wrong in the obvious direction, going on announcing that a colleague was
 * still on the way long after one had been and gone.
 *
 * Inferring it from the conversation does not work either: the colleague's
 * reply might have scrolled out of the window, and a handoff closed without
 * a reply leaves no trace in the thread at all.
 *
 * SO THE RESOLUTION IS RECORDED AS A FACT. A positive "this was marked
 * handled at 23:45" is something the assistant can be told and can repeat;
 * an absence is something it has to guess about.
 *
 * KEPT THROUGH THE NEXT RAISE, deliberately. Raising a new handoff does not
 * clear these — somebody reading the record wants to know a previous one was
 * closed, and the live one is described by `needs_human_since` beside it.
 *
 * EXPAND ONLY. Both columns are nullable, nothing is backfilled, and a row
 * that predates this simply has no resolution recorded — which is honest:
 * we do not know when those were closed.
 */
export class HandoffResolution1761800000000 implements MigrationInterface {
  name = 'HandoffResolution1761800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE customer_assistant_states
        ADD COLUMN IF NOT EXISTS needs_human_resolved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS needs_human_resolved_by BIGINT
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE customer_assistant_states
        DROP COLUMN IF EXISTS needs_human_resolved_by,
        DROP COLUMN IF EXISTS needs_human_resolved_at
    `);
  }
}
