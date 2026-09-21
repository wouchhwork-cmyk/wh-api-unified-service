import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Somewhere to keep what Meta tells us about our own rate limits.
 *
 * Every Graph response carries a usage header and we read none of it, so the
 * first sign of trouble is a refusal — by which point a business's inbox has
 * already stopped updating. This table is the record that makes the position
 * visible BEFORE that, and per business rather than in aggregate.
 *
 * ONE ROW PER SCOPE PER MINUTE. A scope is either the single app-wide meter or
 * one business's pool for one product. Rows are only written for scopes
 * actually called in that minute, so the row rate follows real traffic rather
 * than the number of connected businesses.
 *
 * EXPAND ONLY: a new table and its indexes. Nothing existing is touched, no
 * code depends on it until the collector ships, and dropping it loses only
 * monitoring history.
 */
export class MetaApiUsage1758100000000 implements MigrationInterface {
  name = 'MetaApiUsage1758100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS meta_api_usage (
        id                 BIGSERIAL PRIMARY KEY,
        is_deleted         BOOLEAN NOT NULL DEFAULT false,
        created_at         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

        -- The pool's identity and the ON CONFLICT target. Composed into one
        -- string because a unique index over nullable columns cannot serve an
        -- upsert: Postgres treats two NULLs as distinct, so every flush would
        -- insert a new row instead of folding into the minute's.
        scope_key          VARCHAR(120) NOT NULL,
        meter              VARCHAR(30)  NOT NULL,
        product            VARCHAR(40),
        meta_business_id   VARCHAR(64),

        -- Attribution, resolved from the ids Meta names. No foreign keys: this
        -- is observability, and a deleted channel must neither be blocked by
        -- its usage history nor silently take it away.
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
        CONSTRAINT meta_api_usage_call_pct_chk  CHECK (call_pct  IS NULL OR (call_pct  BETWEEN 0 AND 1000)),
        CONSTRAINT meta_api_usage_cpu_pct_chk   CHECK (cpu_pct   IS NULL OR (cpu_pct   BETWEEN 0 AND 1000)),
        CONSTRAINT meta_api_usage_time_pct_chk  CHECK (time_pct  IS NULL OR (time_pct  BETWEEN 0 AND 1000)),
        CONSTRAINT meta_api_usage_counts_chk    CHECK (calls >= 0 AND throttled_calls >= 0 AND failed_calls >= 0)
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
      CREATE UNIQUE INDEX IF NOT EXISTS meta_api_usage_bucket_uniq
      ON meta_api_usage (scope_key, bucket_start)
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
      CREATE INDEX IF NOT EXISTS meta_api_usage_bucket_start_idx
      ON meta_api_usage (bucket_start)
    `);

    await q.query(`
      COMMENT ON TABLE meta_api_usage IS
        'Meta rate-limit usage, one row per pool per minute. call_pct/cpu_pct/time_pct are META''s percentages of an unstated allowance; calls/throttled_calls/failed_calls are ours. NULL percentage means the header was absent, which is unknown rather than zero.'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS meta_api_usage`);
  }
}
