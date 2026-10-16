import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Somewhere to keep what an upstream provider tells us about our own rate
 * limits.
 *
 * Every Graph response carries a usage header and we read none of it, so the
 * first sign of trouble is a refusal — by which point a business's inbox has
 * already stopped updating. This table is the record that makes the position
 * visible BEFORE that, and per business rather than in aggregate.
 *
 * ONE ROW PER SCOPE PER MINUTE, where a scope is one provider's pool — for Meta
 * that is either the single app-wide meter or one business's pool for one
 * product. The table is provider-neutral because `Provider` already lists four
 * and each meters its API somehow; only the parsing is Meta's. Rows are only written for scopes
 * actually called in that minute, so the row rate follows real traffic rather
 * than the number of connected businesses.
 *
 * EXPAND ONLY: a new table and its indexes. Nothing existing is touched, no
 * code depends on it until the collector ships, and dropping it loses only
 * monitoring history.
 */
export class ProviderApiUsage1758100000000 implements MigrationInterface {
  name = 'ProviderApiUsage1758100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS provider_api_usage (
        id                 BIGSERIAL PRIMARY KEY,
        is_deleted         BOOLEAN NOT NULL DEFAULT false,
        created_at         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

        -- WHOSE quota this is. meta today; Provider already lists google,
        -- zendesk and hubspot, and every one of them meters its API somehow.
        -- Without this column two providers' pools are indistinguishable: the
        -- console could not group by provider, and the allowance windows are
        -- per provider rather than global.
        --
        -- A column rather than something parsed out of scope_key, because a
        -- value you have to split a string to learn is one that eventually
        -- gets split wrong.
        provider           VARCHAR(30)  NOT NULL,

        -- The pool's identity and the ON CONFLICT target. Composed into one
        -- string because a unique index over nullable columns cannot serve an
        -- upsert: Postgres treats two NULLs as distinct, so every flush would
        -- insert a new row instead of folding into the minute's. It carries the
        -- provider too, so two of them cannot collide on one key.
        scope_key          VARCHAR(120) NOT NULL,

        -- What the PROVIDER calls its meter. Meta has two; another will have
        -- its own names, so this is free text rather than a constrained enum.
        meter              VARCHAR(30)  NOT NULL,
        product            VARCHAR(40),

        -- The id the provider keyed this quota under. For Meta that is
        -- sometimes a Business id and sometimes an account id, which is why it
        -- is not called business_id.
        provider_scope_id  VARCHAR(64),

        -- Attribution, resolved from the ids the provider names. No foreign
        -- keys: this is observability, and a deleted channel must neither be
        -- blocked by its usage history nor silently take it away.
        enterprise_id      BIGINT,
        channel_id         BIGINT,

        bucket_start       TIMESTAMPTZ(3) NOT NULL,

        -- Ours, counted locally. Volume.
        calls              INT NOT NULL DEFAULT 0,
        throttled_calls    INT NOT NULL DEFAULT 0,
        failed_calls       INT NOT NULL DEFAULT 0,

        -- Meta's, and PERCENTAGES of an allowance whose size Meta never states.
        -- Nullable because a missing header means UNKNOWN, which is not zero.
        call_pct           SMALLINT,
        cpu_pct            SMALLINT,
        time_pct           SMALLINT,
        regain_minutes     INT,

        last_seen_at       TIMESTAMPTZ(3) NOT NULL,

        -- Meta's figures are whole-number percentages. A value outside this
        -- range means we have misread the header, and a monitor that silently
        -- reports a wrong number is worse than one that fails loudly.
        CONSTRAINT provider_api_usage_call_pct_chk  CHECK (call_pct  IS NULL OR (call_pct  BETWEEN 0 AND 1000)),
        CONSTRAINT provider_api_usage_cpu_pct_chk   CHECK (cpu_pct   IS NULL OR (cpu_pct   BETWEEN 0 AND 1000)),
        CONSTRAINT provider_api_usage_time_pct_chk  CHECK (time_pct  IS NULL OR (time_pct  BETWEEN 0 AND 1000)),
        CONSTRAINT provider_api_usage_counts_chk    CHECK (calls >= 0 AND throttled_calls >= 0 AND failed_calls >= 0)
      )
    `);

    /*
     * The upsert conflict target, and the lookup behind the console's
     * "latest reading per pool".
     *
     * ASCENDING, although the console reads it with `ORDER BY scope_key,
     * bucket_start DESC`. A mixed-direction index would serve that ordering
     * without a sort, and TypeORM's `@Index` cannot express one — so a DESC
     * here would exist in this migration and not in a `db:sync` database, which
     * is precisely the drift `schema-parity.spec.ts` is there to catch.
     *
     * The sort is worth giving up. Retention bounds this table at 48 hours, so
     * the set being ordered is pools x minutes-actually-called, and the planner
     * sorts a few thousand rows rather than walking a few dozen. The index still
     * does the work that matters: it is the conflict target on every flush, and
     * it is what makes the scan proportional to one pool rather than the table.
     */
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS provider_api_usage_bucket_uniq
      ON provider_api_usage (scope_key, bucket_start)
    `);

    /*
     * The retention sweep and the history chart, which both ask for a range of
     * bucket_start and nothing else.
     *
     * There is deliberately NO index on enterprise_id. Nothing queries by it:
     * the console reads every pool in one pass and groups them in the service,
     * because the whole point of the screen is to see all of them at once. An
     * index for a filter nobody applies is write cost on the highest-row-rate
     * table here in exchange for nothing.
     */
    await q.query(`
      CREATE INDEX IF NOT EXISTS provider_api_usage_bucket_start_idx
      ON provider_api_usage (bucket_start)
    `);

    await q.query(`
      COMMENT ON TABLE provider_api_usage IS
        'Upstream API rate-limit usage, one row per provider pool per minute. call_pct/cpu_pct/time_pct are the PROVIDER''s percentages of an allowance it does not state; calls/throttled_calls/failed_calls are ours. NULL percentage means the header was absent, which is unknown rather than zero.'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS provider_api_usage`);
  }
}
