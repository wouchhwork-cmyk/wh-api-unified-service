import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The two assistant switches, per CHANNEL rather than per person.
 *
 * WHY THIS REPLACES COLUMNS ADDED HOURS AGO. They were put on `customers`,
 * which made both switches global to a human being: pausing the assistant
 * while you typed to somebody on Instagram also silenced it on WhatsApp and
 * under every comment they had ever left. That is not what a colleague
 * taking over one conversation is asking for, and the mistake is only
 * visible once you say it out loud — "pause this person" sounds right and
 * means something far wider than intended.
 *
 * SO THE GRAIN IS (customer, channel). A person is reachable in several
 * places and those places are watched by different colleagues on different
 * days; a handoff raised on one account is a fact about that account.
 *
 * CHANNEL AND NOT PLATFORM, matching `customer_engagements`, which made the
 * same choice for the same reason: "an enterprise can run two Instagram
 * accounts and a customer may talk to only one". A flag raised in one
 * business's inbox must not appear in the other's. It also lines up with
 * what somebody is actually looking at — the inbox they have open is a
 * channel, not a platform — and a direct message and a comment on the same
 * account correctly share one flag.
 *
 * THE OLD COLUMNS GO. They are one migration old, no code outside this
 * change reads them and no row has ever had one set — so carrying them
 * through an expand/contract cycle would be ceremony protecting nothing.
 * Their values are copied across first anyway, so the drop cannot lose
 * anything that was there.
 */
export class AssistantStatePerChannel1761700000000 implements MigrationInterface {
  name = 'AssistantStatePerChannel1761700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS customer_assistant_states (
        id                     BIGSERIAL     PRIMARY KEY,
        enterprise_id          BIGINT        NOT NULL,
        customer_id            BIGINT        NOT NULL,
        /* The connected account this applies to, which is the inbox
           somebody is looking at when they raise or clear it. */
        channel_id             BIGINT        NOT NULL,
        needs_human            BOOLEAN       NOT NULL DEFAULT false,
        needs_human_reason     TEXT,
        needs_human_since      TIMESTAMPTZ,
        needs_human_message_id BIGINT,
        automation_paused_at   TIMESTAMPTZ,
        automation_paused_by   BIGINT,
        automation_resumes_at  TIMESTAMPTZ,
        is_deleted             BOOLEAN       NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    /*
     * Carried across before the old columns go, so a flag set between the
     * two migrations is not quietly lost. Against the channel the customer
     * was last seen on, which is the only one those columns could have
     * meant; a customer with no channel on record is skipped rather than
     * guessed at.
     */
    await q.query(`
      INSERT INTO customer_assistant_states
        (enterprise_id, customer_id, channel_id, needs_human, needs_human_reason,
         needs_human_since, needs_human_message_id, automation_paused_at,
         automation_paused_by, automation_resumes_at)
      SELECT cu.enterprise_id, cu.id, cu.last_channel_id, cu.needs_human,
             cu.needs_human_reason, cu.needs_human_since, cu.needs_human_message_id,
             cu.automation_paused_at, cu.automation_paused_by, cu.automation_resumes_at
        FROM customers cu
       WHERE (cu.needs_human = true OR cu.automation_paused_at IS NOT NULL)
         AND cu.last_channel_id IS NOT NULL
    `);

    await q.query(`
      ALTER TABLE customer_assistant_states
        ADD CONSTRAINT customer_assistant_states_enterprise_fk
        FOREIGN KEY (enterprise_id) REFERENCES enterprises (id)
    `);
    await q.query(`
      ALTER TABLE customer_assistant_states
        ADD CONSTRAINT customer_assistant_states_customer_fk
        FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id)
    `);

    await q.query(`
      ALTER TABLE customer_assistant_states
        ADD CONSTRAINT customer_assistant_states_channel_fk
        FOREIGN KEY (channel_id) REFERENCES channels (id)
    `);

    /* One row per person per channel, which is the whole point of the table. */
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS customer_assistant_states_uniq
        ON customer_assistant_states (enterprise_id, customer_id, channel_id)
        WHERE is_deleted = false
    `);

    /*
     * "Who is waiting for a person" — a handful of rows, so partial. Ordered
     * by how long they have waited, which is the only urgency there is.
     */
    await q.query(`
      CREATE INDEX IF NOT EXISTS customer_assistant_states_waiting_idx
        ON customer_assistant_states (enterprise_id, needs_human_since DESC)
        WHERE needs_human = true AND is_deleted = false
    `);

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

  public async down(q: QueryRunner): Promise<void> {
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
    await q.query(`DROP TABLE IF EXISTS customer_assistant_states`);
  }
}
