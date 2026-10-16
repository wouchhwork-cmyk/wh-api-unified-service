import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a thread read ask "did this comment's hide or delete die?" without
 * scanning.
 *
 * The inbox now offers a retry for a moderation send that dead-lettered (todo
 * E19), and it can only offer it where one did. That question is asked once per
 * thread page, for every comment on it, and the existing partial
 * `outbound_events_dead_letter_idx` does not answer it: it is ordered for the
 * gauge's count, not keyed by tenant or by the comment the payload names.
 *
 * Keyed on the payload's comment id because moderation creates no message of
 * its own — it changes one that already exists, so there is no link column to
 * join on.
 *
 * Deliberately narrow. Dead-lettered moderation is rare by construction, being
 * the alarm rather than the ordinary path, so this index stays small and its
 * write cost falls only on rows that are already a human's problem.
 *
 * EXPAND ONLY: additive, idempotent, and nothing depends on it but the planner.
 */
export class ModerationDeadLetterLookup1758400000000 implements MigrationInterface {
  name = 'ModerationDeadLetterLookup1758400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS outbound_events_dead_moderation_idx
      ON outbound_events (enterprise_id, (payload->>'commentId'))
      WHERE status = 'dead_letter'
        AND event_type IN ('comment_hide', 'comment_delete')
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS outbound_events_dead_moderation_idx`);
  }
}
