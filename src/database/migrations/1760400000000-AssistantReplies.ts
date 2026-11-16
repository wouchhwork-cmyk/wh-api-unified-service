import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The reply the assistant owes somebody, as a row.
 *
 * THE HOLE THIS CLOSES. A customer's message was accepted, the inbound event
 * was marked processed, and the obligation to answer existed only as a
 * function call on the stack of a worker. If that process died — a deploy, an
 * OOM, a `kill` — nothing anywhere said an answer was owed. The customer was
 * never answered, and there was not even an audit row, because the crash
 * landed before the one that would have recorded the failure.
 *
 * Every other slow, external, retryable thing in this service is a claimed
 * ledger row: projections, sends, media descriptions. Drafting a reply is a
 * model call and a send; it belongs on the same rails, and this is the table
 * that puts it there.
 *
 * ONE ROW PER INBOUND MESSAGE, which the unique index makes true rather than
 * hoped for. A redelivered webhook, a retried projection and a worker that
 * restarts mid-claim all arrive here with the same message, and exactly one
 * obligation must come out of that.
 *
 * THE PAUSE LIVES HERE NOW. People type in bursts, so a reply waits a moment
 * before it is drafted — and until now that moment was a `setTimeout` inside
 * the worker, which a restart silently dropped along with the reply. It is
 * `next_attempt_at` instead: durable, visible, and the same mechanism as
 * every other backoff in the system.
 */
export class AssistantReplies1760400000000 implements MigrationInterface {
  name = 'AssistantReplies1760400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS assistant_replies (
        id                BIGSERIAL     PRIMARY KEY,
        enterprise_id     BIGINT        NOT NULL,
        conversation_id   BIGINT        NOT NULL,
        /* The inbound message that is owed an answer. */
        message_id        BIGINT        NOT NULL,

        status            VARCHAR(20)   NOT NULL DEFAULT 'pending',

        /*
         * WHY IT WAS NOT ANSWERED, when it was not. The switch was off, a
         * colleague got there first, the thread closed, or the model read it
         * and judged that nothing needed saying — four very different facts
         * that used to be one silence.
         */
        skip_reason       VARCHAR(40),

        /*
         * WHAT ANSWERED IT, for the question somebody actually asks: "why did
         * it say that to my customer". The reply itself is a message row;
         * this names the model and the instruction behind it.
         */
        reply_message_id  BIGINT,
        provider          VARCHAR(20),
        model             VARCHAR(80),
        prompt_version    INTEGER,
        /* What it understood them to want, and whether it asked for a human. */
        intent            VARCHAR(120),
        handoff_reason    VARCHAR(255),

        /* Ledger mechanics, mirroring media_analyses and inbound_events. */
        attempt_count     INTEGER       NOT NULL DEFAULT 0,
        max_attempts      INTEGER       NOT NULL DEFAULT 3,
        lease_owner       VARCHAR(100),
        lease_expires_at  TIMESTAMPTZ,
        next_attempt_at   TIMESTAMPTZ,
        failure_code      VARCHAR(60),
        /*
         * Redacted at the call site. A model error can quote the prompt back,
         * and the prompt is wrapped around a customer's message.
         */
        failure_reason    TEXT,

        /* Billing is per token and the model is chosen in a console, so what
           each reply cost has to be answerable per row. */
        input_tokens      INTEGER,
        output_tokens     INTEGER,
        total_tokens      INTEGER,

        settled_at        TIMESTAMPTZ,
        is_deleted        BOOLEAN       NOT NULL DEFAULT false,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    /*
     * ONE OBLIGATION PER MESSAGE PER BUSINESS. Scoped by enterprise for the
     * same reason every index here is: a message id is ours, and the scope is
     * what keeps a tenant boundary from depending on everybody remembering
     * to write it into the WHERE clause.
     */
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS assistant_replies_message_uniq
      ON assistant_replies (enterprise_id, message_id)
    `);

    /* The claim: due work, oldest first. Partial, so the index stays the size
       of the backlog rather than the size of the archive. */
    await q.query(`
      CREATE INDEX IF NOT EXISTS assistant_replies_due_idx
      ON assistant_replies (COALESCE(next_attempt_at, created_at), id)
      WHERE status IN ('pending', 'failed')
    `);

    /* "What has the assistant been doing in this thread" — the question an
       agent asks with a conversation already open in front of them. */
    await q.query(`
      CREATE INDEX IF NOT EXISTS assistant_replies_conversation_idx
      ON assistant_replies (enterprise_id, conversation_id, id DESC)
    `);

    await q.query(`
      ALTER TABLE assistant_replies
        DROP CONSTRAINT IF EXISTS assistant_replies_enterprise_fk,
        ADD CONSTRAINT assistant_replies_enterprise_fk
            FOREIGN KEY (enterprise_id) REFERENCES enterprises (id)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS assistant_replies`);
  }
}
