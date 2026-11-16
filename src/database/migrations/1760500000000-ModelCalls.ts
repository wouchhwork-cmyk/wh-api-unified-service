import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every call this service makes to a model, one row each.
 *
 * WHATEVER LEAVES THIS SERVICE HAS A RECORD. Sends to Meta have
 * `outbound_events`; Graph calls have `provider_api_usage`. Model calls had
 * neither — what survived was the OUTCOME written onto whatever asked for it,
 * which is not the same thing and loses three questions worth answering:
 *
 *   - A failed attempt still spent tokens. The ledger row it belongs to is
 *     updated in place, so attempt two overwrites attempt one and the money
 *     attempt one cost is simply gone from the record.
 *   - A colleague pressing "draft with AI" made a paid call that left no
 *     trace at all. No ledger row exists for it, because nothing was owed.
 *   - "What did this business spend, on what, and how much of it failed" had
 *     to be assembled from message metadata, which is the wrong shape and
 *     only covers the replies that succeeded.
 *
 * NO PROMPT AND NO RESPONSE TEXT, ever. Both are wrapped around a customer's
 * own words. What is kept is metadata: who it was for, which model, what it
 * cost, how long it took, and why it failed — the failure MESSAGE, which a
 * caller redacts, never the payload that produced it.
 *
 * NOT A BUCKETED METER. `provider_api_usage` counts Graph calls per rolling
 * window because Meta's headers report a percentage of a pool. Neither model
 * provider reports anything of the kind — OpenAI sends no rate-limit headers
 * on the endpoint used here and Gemini sends none at all — so there is no
 * pool to track, and the useful grain is the call: this reply, this cost,
 * this failure.
 */
export class ModelCalls1760500000000 implements MigrationInterface {
  name = 'ModelCalls1760500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS model_calls (
        id                  BIGSERIAL     PRIMARY KEY,
        enterprise_id       BIGINT        NOT NULL,

        provider            VARCHAR(20)   NOT NULL,
        model               VARCHAR(80)   NOT NULL,
        purpose             VARCHAR(30)   NOT NULL,
        status              VARCHAR(10)   NOT NULL,

        /* What it was about, so a cost can be traced to a conversation. Both
           nullable: a chat call names a message, a description names media. */
        message_id          BIGINT,
        media_key           VARCHAR(200),

        /* Which saved instruction produced it. */
        prompt_version      INTEGER,

        input_tokens        INTEGER,
        output_tokens       INTEGER,
        total_tokens        INTEGER,
        /* Billed differently, and worth seeing separately: cached input is
           cheaper, reasoning output is charged and never shown to anybody. */
        cached_input_tokens INTEGER,
        reasoning_tokens    INTEGER,

        /* Wall clock, ours. A model that is answering but slowly is a
           different problem from one that is failing, and only this tells
           them apart before somebody complains. */
        duration_ms         INTEGER,
        /* It ran into the output cap rather than finishing. */
        truncated           BOOLEAN       NOT NULL DEFAULT false,

        failure_code        VARCHAR(60),
        /* Redacted at the call site: a model error can quote the prompt back,
           and the prompt is wrapped around somebody's message. */
        failure_reason      TEXT,

        is_deleted          BOOLEAN       NOT NULL DEFAULT false,
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    /* "What did this business spend, newest first" — the only question this
       table is read for, and the id keeps the order total. */
    await q.query(`
      CREATE INDEX IF NOT EXISTS model_calls_enterprise_idx
      ON model_calls (enterprise_id, created_at DESC, id DESC)
    `);

    /* Failures across the platform: which model started refusing, and when.
       Partial, because they are the small minority and the index should be
       the size of the problem rather than of the traffic. */
    await q.query(`
      CREATE INDEX IF NOT EXISTS model_calls_failure_idx
      ON model_calls (provider, created_at DESC)
      WHERE status = 'failed'
    `);

    await q.query(`
      ALTER TABLE model_calls
        DROP CONSTRAINT IF EXISTS model_calls_enterprise_fk,
        ADD CONSTRAINT model_calls_enterprise_fk
            FOREIGN KEY (enterprise_id) REFERENCES enterprises (id)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS model_calls`);
  }
}
