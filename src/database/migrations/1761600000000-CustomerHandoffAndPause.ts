import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two things a colleague can say about one customer, and the assistant can read.
 *
 * WHY THESE ARE COLUMNS AND NOT A LOG LINE. A handoff already existed in
 * three places — the reply ledger, the message metadata and a warning in the
 * logs — and in none of them could anybody SEE it, clear it, or act on it.
 * So nothing ever ended. Watched live: the assistant set a handoff, then
 * answered the next four messages with "A colleague will take over and help
 * sort this out for you shortly", because nothing in the world could tell it
 * that a colleague had, or had not, or never would.
 *
 * `needs_human` is that state made real. The assistant raises it; a
 * colleague clears it from the portal; and because the assistant is TOLD
 * which it is, "somebody is coming" stops being a thing it repeats forever
 * into a thread nobody is watching.
 *
 * `automation_paused_at` is the other direction: a colleague taking the
 * conversation over by hand and wanting the assistant to be quiet while they
 * do. Without it the only options were leaving the assistant to talk over a
 * person mid-sentence, or turning it off for the whole business.
 *
 * ON THE CUSTOMER, NOT THE CONVERSATION. One of these customers has 32
 * threads with one business — direct messages, comments, story mentions. A
 * colleague who has picked up the phone to somebody does not want the
 * assistant answering them under a post thirty seconds later, and "needs a
 * human" is a fact about the person, not about one of their threads.
 *
 * `automation_resumes_at` is nullable and optional. A pause nobody remembers
 * to lift is an assistant that is silently off forever, which looks exactly
 * like one that is broken — so a colleague may set an hour and have it come
 * back by itself.
 *
 * EXPAND ONLY. Every column is nullable or defaulted, nothing is backfilled,
 * and a deploy changes no existing behaviour: `needs_human` false and
 * `automation_paused_at` null is precisely how the system behaves today.
 */
export class CustomerHandoffAndPause1761600000000 implements MigrationInterface {
  name = 'CustomerHandoffAndPause1761600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE customers
        ADD COLUMN IF NOT EXISTS needs_human              BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS needs_human_reason       TEXT,
        ADD COLUMN IF NOT EXISTS needs_human_since        TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS needs_human_message_id   BIGINT,
        ADD COLUMN IF NOT EXISTS automation_paused_at     TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS automation_paused_by     BIGINT,
        ADD COLUMN IF NOT EXISTS automation_resumes_at    TIMESTAMPTZ
    `);

    /*
     * PARTIAL, because the question asked of it is "who is waiting for a
     * person" — a handful of rows out of every customer this business has
     * ever spoken to. Indexing the false ones would be indexing everybody to
     * find nobody.
     */
    await q.query(`
      CREATE INDEX IF NOT EXISTS customers_needs_human_idx
        ON customers (enterprise_id, needs_human_since DESC)
        WHERE needs_human = true AND is_deleted = false
    `);

    /*
     * The auto-reply gate reads this on every inbound message, by customer.
     * Partial for the same reason: a pause is rare and briefly held.
     */
    await q.query(`
      CREATE INDEX IF NOT EXISTS customers_automation_paused_idx
        ON customers (enterprise_id, id)
        WHERE automation_paused_at IS NOT NULL AND is_deleted = false
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS customers_automation_paused_idx`);
    await q.query(`DROP INDEX IF EXISTS customers_needs_human_idx`);
    await q.query(`
      ALTER TABLE customers
        DROP COLUMN IF EXISTS automation_resumes_at,
        DROP COLUMN IF EXISTS automation_paused_by,
        DROP COLUMN IF EXISTS automation_paused_at,
        DROP COLUMN IF EXISTS needs_human_message_id,
        DROP COLUMN IF EXISTS needs_human_since,
        DROP COLUMN IF EXISTS needs_human_reason,
        DROP COLUMN IF EXISTS needs_human
    `);
  }
}
