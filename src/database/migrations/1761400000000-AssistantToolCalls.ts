import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the assistant asked this service to do, and what happened.
 *
 * WHATEVER GOES OUT OF THIS SERVICE HAS A RECORD, and a tool call is the
 * first thing the assistant does that is not a message. `model_calls`
 * answers "what did we pay for and what did it say"; it cannot answer "why
 * does this customer have a callback booked" or "who decided her name was
 * Priya". Those are decisions a model made on a business's behalf, and the
 * only honest place for them is a row of their own.
 *
 * THE REASON IS A COLUMN, not a detail of the arguments. The model is told
 * its `because` travels into the next call, which is what makes it write a
 * real one — and the same sentence is what a person reading this table gets
 * when they want to know why an API was called about somebody. A ledger of
 * effects without reasons is a list of things that happened to a customer.
 *
 * ARGUMENTS AND RESULT ARE JSONB AND DELIBERATELY UNSHAPED. Every tool has
 * its own, more are coming, and a column per argument would make adding one
 * a migration. What is NOT stored is a transcript: a tool's result is a
 * lookup of our own data, not the conversation, and this table has no
 * business holding a second copy of what somebody said.
 */
export class AssistantToolCalls1761400000000 implements MigrationInterface {
  name = 'AssistantToolCalls1761400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS assistant_tool_calls (
        id               bigserial PRIMARY KEY,
        ref_id           uuid NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id    bigint NOT NULL REFERENCES enterprises(id),
        conversation_id  bigint NOT NULL,
        /* The inbound message being answered when it asked. Null for a draft
           somebody requested, which answers no message in particular. */
        message_id       bigint,
        /* Which model call asked for it, so a tool and the reasoning that
           produced it can be read together. */
        model_call_id    bigint,
        tool_name        varchar(60) NOT NULL,
        effect           varchar(10) NOT NULL,
        /* Which round of the loop. A model that looks something up and then
           acts on it produces two rows, and the order is the story. */
        round            smallint NOT NULL DEFAULT 1,
        outcome          varchar(20) NOT NULL,
        because          text,
        arguments        jsonb NOT NULL DEFAULT '{}'::jsonb,
        result           jsonb,
        note             text,
        duration_ms      integer,
        is_deleted       boolean NOT NULL DEFAULT false,
        created_at       timestamptz(3) NOT NULL DEFAULT now(),
        updated_at       timestamptz(3) NOT NULL DEFAULT now()
      )
    `);

    /* Every read of this table is "what happened in this conversation",
       newest first, within one tenant. */
    await q.query(`
      CREATE INDEX IF NOT EXISTS assistant_tool_calls_thread_idx
        ON assistant_tool_calls (enterprise_id, conversation_id, created_at DESC, id DESC)
        WHERE is_deleted = false
    `);

    /* Addressed by its public id, never by the row id. */
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS assistant_tool_calls_ref_uniq
        ON assistant_tool_calls (ref_id)
    `);

    /* "How often is each tool used, and how often does it fail" — the
       question that decides whether a tool is worth its place in the prompt,
       which every call pays for. */
    await q.query(`
      CREATE INDEX IF NOT EXISTS assistant_tool_calls_usage_idx
        ON assistant_tool_calls (enterprise_id, tool_name, outcome, created_at DESC)
        WHERE is_deleted = false
    `);
    /*
     * AND THE ONE THING A TOOL PROMISES SOMEBODY.
     *
     * A callback is not a log line: somebody has to ring a customer who was
     * told they would be rung. Its own table rather than a note on the
     * conversation, because the people who make those calls work from a
     * list of them — a promise buried in a thread is a promise nobody keeps.
     *
     * `status` is the whole point of the row. Requested, done, or dropped
     * with a reason: a request with no way to close it becomes a list that
     * only grows, which is a list nobody reads.
     */
    await q.query(`
      CREATE TABLE IF NOT EXISTS callback_requests (
        id               bigserial PRIMARY KEY,
        ref_id           uuid NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id    bigint NOT NULL REFERENCES enterprises(id),
        conversation_id  bigint NOT NULL,
        customer_id      bigint NOT NULL,
        /* The message that asked for it, so whoever rings can read why. */
        message_id       bigint,
        phone            varchar(40) NOT NULL,
        reason           text NOT NULL,
        when_reachable   text,
        status           varchar(20) NOT NULL DEFAULT 'requested',
        /* Who asked: the assistant, or a colleague through the console. */
        requested_by     varchar(20) NOT NULL DEFAULT 'assistant',
        resolved_at      timestamptz(3),
        resolution_note  text,
        is_deleted       boolean NOT NULL DEFAULT false,
        created_at       timestamptz(3) NOT NULL DEFAULT now(),
        updated_at       timestamptz(3) NOT NULL DEFAULT now()
      )
    `);

    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS callback_requests_ref_uniq
        ON callback_requests (ref_id)
    `);

    /* The work queue: what is still outstanding for this business, oldest
       first, because somebody has been waiting longest for that one. */
    await q.query(`
      CREATE INDEX IF NOT EXISTS callback_requests_open_idx
        ON callback_requests (enterprise_id, created_at)
        WHERE is_deleted = false AND status = 'requested'
    `);

    /*
     * ONE OPEN REQUEST PER CONVERSATION, enforced here rather than left to
     * the tool.
     *
     * A model that calls a tool and then answers can be asked again a minute
     * later by a customer who says "did you get that?" — and the obvious
     * reading of that question is to make sure, which is a second colleague
     * ringing the same person about the same thing. The prompt asks it not
     * to; a partial unique index is what makes asking unnecessary.
     */
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS callback_requests_one_open_uniq
        ON callback_requests (enterprise_id, conversation_id)
        WHERE is_deleted = false AND status = 'requested'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS callback_requests`);
    await q.query(`DROP TABLE IF EXISTS assistant_tool_calls`);
  }
}
