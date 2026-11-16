import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The name a platform gave us, kept apart from the name this business holds.
 *
 * THERE WAS ONE SLOT AND THE PLATFORM OWNED IT. `applyPlatformProfile` wrote
 * `display_name = COALESCE($3, display_name)` straight onto the customer, so
 * the last platform to answer won — and the moment anybody can type a name
 * into this product, the next refresh overwrites it without a word. There is
 * no edit path today, which is the only reason that has not happened yet.
 *
 * KEYED ON THE IDENTIFIER, NOT ON (customer, platform). A profile belongs to
 * an ACCOUNT, and an account is what `customer_identifiers` already holds.
 * Keying on the platform instead would have collapsed two real accounts into
 * one row the first time a merge gave one customer two Instagram profiles —
 * the same bug this migration exists to fix, one level further down. It also
 * throws away something already recorded: `conversations.customer_identifier_id`
 * says which account a thread is with, which is exactly the profile to
 * prefer when rendering it.
 *
 * THE ACCOUNT ID, NOT THE HANDLE. A customer carries two rows for one
 * Instagram account — `instagram_user_id` and `instagram_username`. The
 * profile belongs to the account, so the link prefers the user id, which is
 * stable, over the username, which people change. The handle is used only
 * where no user id was ever recorded.
 *
 * THE BACKFILL IS SAFE BECAUSE NOTHING STAFF-ENTERED EXISTS YET. Every name
 * and picture on `customers` today arrived from Meta, so moving them loses
 * nothing — and clearing them afterwards is what makes the main record
 * honestly empty rather than a muddle of two sources nobody can untangle.
 * Customers whose `first_source` is `import` or `manual` are left entirely
 * alone: those names are not a platform's to move.
 *
 * `metadata` is COPIED, NOT MOVED. Follower counts belong to a platform, but
 * the customer's own bag is merged from several sources and read in places
 * that know nothing about platforms. Splitting that is a separate job.
 */
export class CustomerPlatformProfiles1760800000000 implements MigrationInterface {
  name = 'CustomerPlatformProfiles1760800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS customer_platform_profiles (
        id                     BIGSERIAL     PRIMARY KEY,
        enterprise_id          BIGINT        NOT NULL,
        /* The account this profile is of. */
        customer_identifier_id BIGINT        NOT NULL,
        /* Denormalised from the identifier so the fallback lookup — "any
           profile for this person" — is one index probe rather than a join. */
        customer_id            BIGINT        NOT NULL,
        platform               VARCHAR(30)   NOT NULL,

        display_name           VARCHAR(255),
        first_name             VARCHAR(100),
        last_name              VARCHAR(100),
        /* A signed CDN link that expires, which is why fetched_at is beside
           it: an avatar is refreshed, not stored once. */
        avatar_url             TEXT,

        metadata               JSONB         NOT NULL DEFAULT '{}'::jsonb,
        fetched_at             TIMESTAMPTZ,

        is_deleted             BOOLEAN       NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    /* One profile per account. The upsert's conflict target, and the probe a
       conversation makes when it knows which account it is with. */
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS customer_platform_profiles_identifier_uniq
      ON customer_platform_profiles (enterprise_id, customer_identifier_id)
    `);

    /* The fallback: the freshest profile this person has, on any account. */
    await q.query(`
      CREATE INDEX IF NOT EXISTS customer_platform_profiles_customer_idx
      ON customer_platform_profiles (enterprise_id, customer_id, fetched_at DESC)
    `);

    /*
     * SEARCH FOLLOWS THE NAMES. `customers_name_trgm_idx` was the whole of
     * customer search, and with the names moved it now indexes a column that
     * is null for everybody who came from a platform — which is everybody.
     * Without this, searching for a customer by name silently returns
     * nothing: no error, no empty-index warning, just a directory that
     * stopped finding people.
     */
    await q.query(`
      CREATE INDEX IF NOT EXISTS customer_platform_profiles_name_trgm_idx
      ON customer_platform_profiles USING gin (display_name gin_trgm_ops)
    `);

    await q.query(`
      ALTER TABLE customer_platform_profiles
        DROP CONSTRAINT IF EXISTS customer_platform_profiles_enterprise_fk,
        ADD CONSTRAINT customer_platform_profiles_enterprise_fk
            FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        DROP CONSTRAINT IF EXISTS customer_platform_profiles_identifier_fk,
        ADD CONSTRAINT customer_platform_profiles_identifier_fk
            FOREIGN KEY (customer_identifier_id) REFERENCES customer_identifiers (id)
    `);

    /*
     * One profile per customer, attached to their best identifier: the
     * account id where one exists, the handle where it does not. The
     * platform comes from the identifier's own kind rather than from
     * `first_source`, because the identifier is what the profile is of.
     */
    await q.query(`
      INSERT INTO customer_platform_profiles
        (enterprise_id, customer_identifier_id, customer_id, platform,
         display_name, first_name, last_name, avatar_url, metadata, fetched_at)
      SELECT cu.enterprise_id, ci.id, cu.id,
             CASE
               WHEN ci.identifier_kind IN ('instagram_user_id', 'instagram_username')
                 THEN 'instagram'
               WHEN ci.identifier_kind = 'facebook_user_id' THEN 'facebook'
               WHEN ci.identifier_kind = 'whatsapp_number'  THEN 'whatsapp'
             END,
             cu.display_name, cu.first_name, cu.last_name, cu.avatar_url,
             COALESCE(cu.metadata, '{}'::jsonb),
             NULLIF(cu.metadata->>'profileFetchedAt', '')::timestamptz
        FROM customers cu
        JOIN LATERAL (
          SELECT ci.id, ci.identifier_kind
            FROM customer_identifiers ci
           WHERE ci.enterprise_id = cu.enterprise_id
             AND ci.customer_id = cu.id
             AND ci.is_deleted = false
             AND ci.identifier_kind IN
                 ('instagram_user_id', 'facebook_user_id', 'whatsapp_number',
                  'instagram_username')
           /* The account id first; the handle only where none was recorded. */
           ORDER BY (ci.identifier_kind IN
                     ('instagram_user_id', 'facebook_user_id', 'whatsapp_number')) DESC,
                    ci.id
           LIMIT 1
        ) ci ON true
       WHERE cu.first_source IN
             ('instagram_dm', 'instagram_comment', 'facebook_dm', 'facebook_comment')
         AND (cu.display_name IS NOT NULL
              OR cu.first_name IS NOT NULL
              OR cu.last_name IS NOT NULL
              OR cu.avatar_url IS NOT NULL)
      ON CONFLICT (enterprise_id, customer_identifier_id) DO NOTHING
    `);

    /*
     * And the main record becomes empty, which is the point: what is left on
     * `customers` from here is what somebody at this business put there.
     */
    await q.query(`
      UPDATE customers cu
         SET display_name = NULL, first_name = NULL, last_name = NULL,
             avatar_url = NULL, updated_at = now()
       WHERE EXISTS (
         SELECT 1 FROM customer_platform_profiles pp
          WHERE pp.enterprise_id = cu.enterprise_id AND pp.customer_id = cu.id
       )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    /* Back onto the customer, so reverting does not lose the names. */
    await q.query(`
      UPDATE customers cu
         SET display_name = COALESCE(cu.display_name, pp.display_name),
             first_name   = COALESCE(cu.first_name, pp.first_name),
             last_name    = COALESCE(cu.last_name, pp.last_name),
             avatar_url   = COALESCE(cu.avatar_url, pp.avatar_url)
        FROM customer_platform_profiles pp
       WHERE pp.enterprise_id = cu.enterprise_id AND pp.customer_id = cu.id
    `);
    await q.query(`DROP TABLE IF EXISTS customer_platform_profiles`);
  }
}
