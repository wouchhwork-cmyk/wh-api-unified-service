import type { MigrationInterface, QueryRunner } from 'typeorm';
import { applyPostTableObjects, applyPreTableObjects } from '../schema/schema-objects';

/**
 * The V1 schema, exactly as docs/schema.md defines it.
 *
 * Hand-written SQL, never generated: the schema depends on partial unique
 * indexes, expression indexes, composite foreign keys routed through
 * enterprise_id, CHECK constraints, and gin_trgm_ops — none of which TypeORM's
 * synchroniser can represent. This file is the authority for qa and prod;
 * entities carry columns only (backend-design.md §5.1).
 *
 * Everything that is not a CREATE TABLE lives in ../schema/schema-objects.ts,
 * shared with the dev-only `pnpm db:sync` path so the two cannot drift. What
 * remains here is the table definitions and the order the three phases run in:
 *
 *   1. extensions + the updated_at trigger function   (shared)
 *   2. every CREATE TABLE (columns and primary keys only)
 *   3. unique indexes, foreign keys, supporting indexes, CHECKs, triggers, and
 *      the audit_logs write restriction               (shared)
 */
export class InitialSchema1756000000000 implements MigrationInterface {
  name = 'InitialSchema1756000000000';

  public async up(q: QueryRunner): Promise<void> {
    const run = (sql: string): Promise<unknown> => q.query(sql);

    await applyPreTableObjects(run);
    // =======================================================================
    // 2. Tables
    // =======================================================================

    // --- 1. enterprises ---------------------------------------------------
    await q.query(`
      CREATE TABLE enterprises (
        id                     BIGSERIAL    PRIMARY KEY,
        ref_id                 UUID         NOT NULL DEFAULT gen_random_uuid(),
        name                   VARCHAR(255) NOT NULL,
        slug                   VARCHAR(100) NOT NULL,
        email                  VARCHAR(255) NOT NULL,
        mobile                 VARCHAR(16),
        mobile_country_code    VARCHAR(2),
        mobile_calling_code    VARCHAR(4),
        mobile_national_number VARCHAR(15),
        website_url            TEXT,
        logo_url               TEXT,
        address                TEXT,
        city                   VARCHAR(100),
        state                  VARCHAR(100),
        country                VARCHAR(2)   NOT NULL DEFAULT 'IN',
        pincode                VARCHAR(10),
        timezone               VARCHAR(50)  NOT NULL DEFAULT 'Asia/Kolkata',
        status                 VARCHAR(30)  NOT NULL DEFAULT 'active',
        is_deleted             BOOLEAN      NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    // --- 2. identities ----------------------------------------------------
    // Both credentials are nullable so either signup path works; the CHECK in
    // section 6 forbids a row with neither.
    await q.query(`
      CREATE TABLE identities (
        id                     BIGSERIAL    PRIMARY KEY,
        ref_id                 UUID         NOT NULL DEFAULT gen_random_uuid(),
        email                  VARCHAR(255),
        mobile                 VARCHAR(16),
        mobile_country_code    VARCHAR(2),
        mobile_calling_code    VARCHAR(4),
        mobile_national_number VARCHAR(15),
        password_hash          TEXT         NOT NULL,
        email_verified_at      TIMESTAMPTZ,
        mobile_verified_at     TIMESTAMPTZ,
        first_name             VARCHAR(100) NOT NULL,
        last_name              VARCHAR(100),
        avatar_url             TEXT,
        status                 VARCHAR(30)  NOT NULL DEFAULT 'active',
        failed_login_count     INTEGER      NOT NULL DEFAULT 0,
        locked_until           TIMESTAMPTZ,
        last_login_at          TIMESTAMPTZ,
        is_deleted             BOOLEAN      NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    // --- 3. enterprise_employees --------------------------------------------
    await q.query(`
      CREATE TABLE enterprise_employees (
        id                    BIGSERIAL    PRIMARY KEY,
        ref_id                UUID         NOT NULL DEFAULT gen_random_uuid(),
        identity_id           BIGINT       NOT NULL,
        enterprise_id         BIGINT       NOT NULL,
        employee_kind           VARCHAR(30)  NOT NULL DEFAULT 'enterprise',
        status                VARCHAR(30)  NOT NULL DEFAULT 'invited',
        invited_by_employee_id  BIGINT,
        invited_at            TIMESTAMPTZ,
        joined_at             TIMESTAMPTZ,
        last_active_at        TIMESTAMPTZ,
        is_deleted            BOOLEAN      NOT NULL DEFAULT false,
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    // --- 4. staff_members -------------------------------------------------
    await q.query(`
      CREATE TABLE staff_members (
        id                        BIGSERIAL   PRIMARY KEY,
        ref_id                    UUID        NOT NULL DEFAULT gen_random_uuid(),
        identity_id               BIGINT      NOT NULL,
        has_all_enterprise_access BOOLEAN     NOT NULL DEFAULT false,
        status                    VARCHAR(30) NOT NULL DEFAULT 'active',
        is_deleted                BOOLEAN     NOT NULL DEFAULT false,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // --- 9. features (before permissions, which references it) ------------
    await q.query(`
      CREATE TABLE features (
        id          BIGSERIAL    PRIMARY KEY,
        ref_id      UUID         NOT NULL DEFAULT gen_random_uuid(),
        "key"       VARCHAR(50)  NOT NULL,
        name        VARCHAR(100) NOT NULL,
        description TEXT,
        status      VARCHAR(30)  NOT NULL DEFAULT 'active',
        is_deleted  BOOLEAN      NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    // --- 5. roles ---------------------------------------------------------
    // enterprise_id NULL = a Wouchh-scoped role or an enterprise-role template.
    await q.query(`
      CREATE TABLE roles (
        id            BIGSERIAL    PRIMARY KEY,
        ref_id        UUID         NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id BIGINT,
        scope         VARCHAR(30)  NOT NULL DEFAULT 'enterprise',
        name          VARCHAR(50)  NOT NULL,
        description   VARCHAR(255),
        is_system     BOOLEAN      NOT NULL DEFAULT false,
        status        VARCHAR(30)  NOT NULL DEFAULT 'active',
        is_deleted    BOOLEAN      NOT NULL DEFAULT false,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    // --- 6. permissions ---------------------------------------------------
    // feature_id is what makes feature-level and action-level access ONE system.
    await q.query(`
      CREATE TABLE permissions (
        id          BIGSERIAL     PRIMARY KEY,
        ref_id      UUID          NOT NULL DEFAULT gen_random_uuid(),
        code        VARCHAR(100)  NOT NULL,
        resource    VARCHAR(50)   NOT NULL,
        action      VARCHAR(50)   NOT NULL,
        feature_id  BIGINT,
        scope       VARCHAR(30)   NOT NULL DEFAULT 'enterprise',
        description VARCHAR(255),
        status      VARCHAR(30)   NOT NULL DEFAULT 'active',
        is_deleted  BOOLEAN       NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 7. role_permissions ----------------------------------------------
    await q.query(`
      CREATE TABLE role_permissions (
        id            BIGSERIAL   PRIMARY KEY,
        role_id       BIGINT      NOT NULL,
        permission_id BIGINT      NOT NULL,
        is_deleted    BOOLEAN     NOT NULL DEFAULT false,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // --- 8. employee_roles --------------------------------------------------
    // enterprise_id is denormalised so both foreign keys can route through it.
    await q.query(`
      CREATE TABLE employee_roles (
        id                   BIGSERIAL   PRIMARY KEY,
        enterprise_id        BIGINT      NOT NULL,
        employee_id            BIGINT      NOT NULL,
        role_id              BIGINT      NOT NULL,
        granted_by_employee_id BIGINT,
        granted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        is_deleted           BOOLEAN     NOT NULL DEFAULT false,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // --- 10. enterprise_features ------------------------------------------
    // status is the SINGLE source of truth; the timestamps are audit trail.
    await q.query(`
      CREATE TABLE enterprise_features (
        id                     BIGSERIAL     PRIMARY KEY,
        ref_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id          BIGINT        NOT NULL,
        feature_id             BIGINT        NOT NULL,
        config                 JSONB         NOT NULL DEFAULT '{}',
        status                 VARCHAR(30)   NOT NULL DEFAULT 'access_requested',
        requested_by_employee_id BIGINT,
        requested_at           TIMESTAMPTZ,
        decided_by_staff_id    BIGINT,
        decided_at             TIMESTAMPTZ,
        decline_reason         VARCHAR(255),
        enabled_at             TIMESTAMPTZ,
        disabled_at            TIMESTAMPTZ,
        expires_at             TIMESTAMPTZ,
        is_deleted             BOOLEAN       NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 11. sessions -----------------------------------------------------
    // No status column: revoked is revoked_at IS NOT NULL, expired is
    // expires_at <= now(). A stored status would lie between sweeps.
    await q.query(`
      CREATE TABLE sessions (
        id                 BIGSERIAL     PRIMARY KEY,
        identity_id        BIGINT        NOT NULL,
        refresh_token_hash VARCHAR(128)  NOT NULL,
        device_info        TEXT,
        ip_address         INET,
        expires_at         TIMESTAMPTZ   NOT NULL,
        revoked_at         TIMESTAMPTZ,
        is_deleted         BOOLEAN       NOT NULL DEFAULT false,
        created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 11b. oauth_states -------------------------------------------------
    // One row per outstanding OAuth attempt, which is what makes `state`
    // single-use: consumption is one conditional UPDATE, so of two callbacks
    // carrying the same state exactly one wins. A signature alone leaves the
    // token replayable for as long as it is valid.
    await run(`
      CREATE TABLE oauth_states (
        id            BIGSERIAL     PRIMARY KEY,
        nonce         VARCHAR(64)   NOT NULL,
        enterprise_id BIGINT        NOT NULL,
        employee_id   BIGINT,
        expires_at    TIMESTAMPTZ   NOT NULL,
        consumed_at   TIMESTAMPTZ,
        is_deleted    BOOLEAN       NOT NULL DEFAULT false,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 12. verifications -------------------------------------------------
    // No status column: usability is derived from consumed_at / superseded_at /
    // expires_at / attempt_count. delivery_status IS stored, because it reflects
    // what a provider told us and cannot be derived from anything we hold.
    await q.query(`
      CREATE TABLE verifications (
        id                     BIGSERIAL     PRIMARY KEY,
        ref_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
        subject_kind           VARCHAR(20)   NOT NULL,
        identity_id            BIGINT,
        enterprise_id          BIGINT,
        customer_id            BIGINT,
        customer_identifier_id BIGINT,
        verification_kind      VARCHAR(40)   NOT NULL,
        delivery_channel       VARCHAR(20)   NOT NULL,
        destination            VARCHAR(320)  NOT NULL,
        secret_hash            VARCHAR(128)  NOT NULL,
        expires_at             TIMESTAMPTZ   NOT NULL,
        consumed_at            TIMESTAMPTZ,
        superseded_at          TIMESTAMPTZ,
        attempt_count          INTEGER       NOT NULL DEFAULT 0,
        max_attempts           INTEGER       NOT NULL DEFAULT 5,
        resend_count           INTEGER       NOT NULL DEFAULT 0,
        last_sent_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
        outbound_event_id      BIGINT,
        delivery_status        VARCHAR(30)   NOT NULL DEFAULT 'pending',
        requested_ip           INET,
        requested_user_agent   TEXT,
        is_deleted             BOOLEAN       NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 13. provider_connections ------------------------------------------
    // access_token holds the self-describing encrypted envelope
    // (v1:<keyVersion>:<nonce>:<ciphertext||tag>) — never plaintext, never logged.
    await q.query(`
      CREATE TABLE provider_connections (
        id                     BIGSERIAL     PRIMARY KEY,
        ref_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id          BIGINT        NOT NULL,
        provider               VARCHAR(30)   NOT NULL,
        provider_category      VARCHAR(30)   NOT NULL,
        provider_user_id       VARCHAR(255)  NOT NULL,
        provider_user_name     VARCHAR(255),
        access_token           TEXT          NOT NULL,
        token_expires_at       TIMESTAMPTZ,
        token_status           VARCHAR(30)   NOT NULL DEFAULT 'valid',
        reauth_required        BOOLEAN       NOT NULL DEFAULT false,
        reauth_notified_at     TIMESTAMPTZ,
        granted_scopes         TEXT,
        connected_by_employee_id BIGINT,
        status                 VARCHAR(30)   NOT NULL DEFAULT 'active',
        is_deleted             BOOLEAN       NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 14. channels -------------------------------------------------------
    // parent_channel_id exists because Meta requires it: an Instagram account is
    // reached THROUGH its linked Facebook Page, whose token authorises the call.
    await q.query(`
      CREATE TABLE channels (
        id                     BIGSERIAL     PRIMARY KEY,
        ref_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
        provider_connection_id BIGINT        NOT NULL,
        enterprise_id          BIGINT        NOT NULL,
        parent_channel_id      BIGINT,
        platform               VARCHAR(30)   NOT NULL,
        channel_kind           VARCHAR(30)   NOT NULL,
        platform_channel_id    VARCHAR(255)  NOT NULL,
        name                   VARCHAR(255),
        username               VARCHAR(255),
        description            TEXT,
        profile_picture_url    TEXT,
        follower_count         INTEGER       NOT NULL DEFAULT 0,
        post_count             INTEGER       NOT NULL DEFAULT 0,
        access_token           TEXT,
        token_expires_at       TIMESTAMPTZ,
        token_status           VARCHAR(30)   NOT NULL DEFAULT 'valid',
        reauth_required        BOOLEAN       NOT NULL DEFAULT false,
        is_managed             BOOLEAN       NOT NULL DEFAULT true,
        metadata               JSONB         NOT NULL DEFAULT '{}',
        status                 VARCHAR(30)   NOT NULL DEFAULT 'active',
        profile_synced_at      TIMESTAMPTZ,
        -- Present = this Page is subscribed to our webhook fields, so events
        -- will arrive. A FACT, not a status: a channel can hold a perfectly good
        -- token (and send) while receiving nothing, and one column cannot say
        -- both without lying about one of them.
        webhook_subscribed_at  TIMESTAMPTZ,
        is_deleted             BOOLEAN       NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 15. sync_jobs ------------------------------------------------------
    // page_cursor is deliberately opaque TEXT: every platform's cursor format
    // differs and none should be parsed.
    await q.query(`
      CREATE TABLE sync_jobs (
        id                  BIGSERIAL     PRIMARY KEY,
        ref_id              UUID          NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id       BIGINT        NOT NULL,
        channel_id          BIGINT        NOT NULL,
        job_kind            VARCHAR(50)   NOT NULL,
        trigger_kind        VARCHAR(30)   NOT NULL,
        status              VARCHAR(30)   NOT NULL DEFAULT 'pending',
        page_cursor         TEXT,
        window_start_at     TIMESTAMPTZ,
        window_end_at       TIMESTAMPTZ,
        synced_item_count   INTEGER       NOT NULL DEFAULT 0,
        expected_item_count INTEGER,
        lease_owner         VARCHAR(100),
        lease_expires_at    TIMESTAMPTZ,
        rate_limited_until  TIMESTAMPTZ,
        attempt_count       INTEGER       NOT NULL DEFAULT 0,
        max_attempts        INTEGER       NOT NULL DEFAULT 5,
        next_attempt_at     TIMESTAMPTZ,
        last_error          TEXT,
        last_error_at       TIMESTAMPTZ,
        started_at          TIMESTAMPTZ,
        completed_at        TIMESTAMPTZ,
        dead_lettered_at    TIMESTAMPTZ,
        is_deleted          BOOLEAN       NOT NULL DEFAULT false,
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 16. customers ------------------------------------------------------
    // No is_blocked boolean: status is the single source of truth, and
    // blocked_at / blocked_by_employee_id / block_reason are audit trail only.
    // first_source is IMMUTABLE — attribution, not current state.
    await q.query(`
      CREATE TABLE customers (
        id                      BIGSERIAL     PRIMARY KEY,
        enterprise_id           BIGINT        NOT NULL,
        ref_id                  UUID          NOT NULL DEFAULT gen_random_uuid(),
        display_name            VARCHAR(255),
        first_name              VARCHAR(100),
        last_name               VARCHAR(100),
        avatar_url              TEXT,
        locale                  VARCHAR(20),
        timezone                VARCHAR(50),
        preferred_language      VARCHAR(20),
        first_source            VARCHAR(30)   NOT NULL,
        first_channel_id        BIGINT,
        last_channel_id         BIGINT,
        notes                   TEXT,
        tags                    JSONB         NOT NULL DEFAULT '[]',
        metadata                JSONB         NOT NULL DEFAULT '{}',
        blocked_at              TIMESTAMPTZ,
        blocked_by_employee_id    BIGINT,
        block_reason            VARCHAR(255),
        conversation_count      INTEGER       NOT NULL DEFAULT 0,
        merged_into_customer_id BIGINT,
        first_seen_at           TIMESTAMPTZ,
        last_seen_at            TIMESTAMPTZ,
        status                  VARCHAR(30)   NOT NULL DEFAULT 'active',
        is_deleted              BOOLEAN       NOT NULL DEFAULT false,
        created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 17. customer_identifiers -------------------------------------------
    // The largest table in the schema. identifier_value is the NORMALISED
    // canonical form (what every index and lookup uses); identifier_value_raw is
    // exactly what arrived, for display and support only.
    await q.query(`
      CREATE TABLE customer_identifiers (
        id                   BIGSERIAL     PRIMARY KEY,
        enterprise_id        BIGINT        NOT NULL,
        customer_id          BIGINT        NOT NULL,
        identifier_kind      VARCHAR(40)   NOT NULL,
        identifier_value     VARCHAR(320)  NOT NULL,
        identifier_value_raw VARCHAR(320),
        country_code         VARCHAR(2),
        calling_code         VARCHAR(4),
        national_number      VARCHAR(15),
        is_primary           BOOLEAN       NOT NULL DEFAULT false,
        verification_status  VARCHAR(30)   NOT NULL DEFAULT 'unverified',
        verified_at          TIMESTAMPTZ,
        verification_method  VARCHAR(30),
        source               VARCHAR(30)   NOT NULL,
        first_seen_at        TIMESTAMPTZ,
        last_seen_at         TIMESTAMPTZ,
        status               VARCHAR(30)   NOT NULL DEFAULT 'active',
        released_at          TIMESTAMPTZ,
        is_deleted           BOOLEAN       NOT NULL DEFAULT false,
        created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 18. customer_engagements -------------------------------------------
    // Channel grain, not platform grain: an enterprise can run two Instagram
    // accounts and a customer may talk to only one. No status column — "dormant"
    // is last_engaged_at being old.
    await q.query(`
      CREATE TABLE customer_engagements (
        id                     BIGSERIAL     PRIMARY KEY,
        enterprise_id          BIGINT        NOT NULL,
        customer_id            BIGINT        NOT NULL,
        channel_id             BIGINT        NOT NULL,
        platform               VARCHAR(30)   NOT NULL,
        first_engaged_at       TIMESTAMPTZ   NOT NULL,
        last_engaged_at        TIMESTAMPTZ   NOT NULL,
        conversation_count     INTEGER       NOT NULL DEFAULT 0,
        inbound_message_count  INTEGER       NOT NULL DEFAULT 0,
        outbound_message_count INTEGER       NOT NULL DEFAULT 0,
        last_conversation_id   BIGINT,
        is_deleted             BOOLEAN       NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 19. posts ----------------------------------------------------------
    // Metric counts are BIGINT: a viral reel passes the INTEGER ceiling. They
    // are SNAPSHOTS, not truth — metrics_synced_at says how stale they are.
    await q.query(`
      CREATE TABLE posts (
        id                     BIGSERIAL     PRIMARY KEY,
        ref_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id          BIGINT        NOT NULL,
        channel_id             BIGINT        NOT NULL,
        platform               VARCHAR(30)   NOT NULL,
        platform_post_id       VARCHAR(255)  NOT NULL,
        post_kind              VARCHAR(30)   NOT NULL,
        caption                TEXT,
        permalink_url          TEXT,
        media                  JSONB         NOT NULL DEFAULT '[]',
        like_count             BIGINT        NOT NULL DEFAULT 0,
        comment_count          BIGINT        NOT NULL DEFAULT 0,
        share_count            BIGINT        NOT NULL DEFAULT 0,
        view_count             BIGINT        NOT NULL DEFAULT 0,
        save_count             BIGINT        NOT NULL DEFAULT 0,
        reach_count            BIGINT        NOT NULL DEFAULT 0,
        metrics                JSONB         NOT NULL DEFAULT '{}',
        metrics_synced_at      TIMESTAMPTZ,
        authored_by_employee_id  BIGINT,
        published_at           TIMESTAMPTZ,
        platform_deleted_at    TIMESTAMPTZ,
        status                 VARCHAR(30)   NOT NULL DEFAULT 'published',
        synced_at              TIMESTAMPTZ,
        is_deleted             BOOLEAN       NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 20. conversations ---------------------------------------------------
    // platform_thread_id is NOT NULL, which is what makes the thread key
    // actually dedup: Meta has no thread object for comments, so the key is
    // derived and prefixed by kind (dm:, comment:, mention:, review:).
    await q.query(`
      CREATE TABLE conversations (
        id                     BIGSERIAL     PRIMARY KEY,
        ref_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
        enterprise_id          BIGINT        NOT NULL,
        channel_id             BIGINT        NOT NULL,
        customer_id            BIGINT        NOT NULL,
        customer_identifier_id BIGINT,
        post_id                BIGINT,
        platform               VARCHAR(30)   NOT NULL,
        conversation_kind      VARCHAR(30)   NOT NULL,
        platform_thread_id     VARCHAR(255)  NOT NULL,
        subject                VARCHAR(500),
        context_url            TEXT,
        context_metadata       JSONB         NOT NULL DEFAULT '{}',
        tags                   JSONB         NOT NULL DEFAULT '[]',
        metadata               JSONB         NOT NULL DEFAULT '{}',
        assigned_to_employee_id  BIGINT,
        assigned_at            TIMESTAMPTZ,
        message_count          INTEGER       NOT NULL DEFAULT 0,
        unread_count           INTEGER       NOT NULL DEFAULT 0,
        last_message_at        TIMESTAMPTZ,
        last_inbound_at        TIMESTAMPTZ,
        first_responded_at     TIMESTAMPTZ,
        resolved_at            TIMESTAMPTZ,
        status                 VARCHAR(30)   NOT NULL DEFAULT 'open',
        is_deleted             BOOLEAN       NOT NULL DEFAULT false,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 21. messages --------------------------------------------------------
    // Where the domain layer links to the transport ledger: inbound_event_id is
    // the event this was projected from, outbound_event_id the dispatch
    // delivering it. Both NULL for an internal note.
    await q.query(`
      CREATE TABLE messages (
        id                    BIGSERIAL     PRIMARY KEY,
        ref_id                UUID          NOT NULL DEFAULT gen_random_uuid(),
        conversation_id       BIGINT        NOT NULL,
        enterprise_id         BIGINT        NOT NULL,
        direction             VARCHAR(10)   NOT NULL,
        customer_id           BIGINT,
        sent_by_employee_id     BIGINT,
        parent_message_id     BIGINT,
        inbound_event_id      BIGINT,
        outbound_event_id     BIGINT,
        platform_message_id   VARCHAR(255),
        idempotency_key       VARCHAR(64),
        message_kind          VARCHAR(30)   NOT NULL DEFAULT 'text',
        body                  TEXT,
        has_attachments       BOOLEAN       NOT NULL DEFAULT false,
        like_count            INTEGER       NOT NULL DEFAULT 0,
        metadata              JSONB         NOT NULL DEFAULT '{}',
        is_read               BOOLEAN       NOT NULL DEFAULT false,
        is_internal_note      BOOLEAN       NOT NULL DEFAULT false,
        is_hidden_on_platform BOOLEAN       NOT NULL DEFAULT false,
        platform_sent_at      TIMESTAMPTZ,
        platform_deleted_at   TIMESTAMPTZ,
        status                VARCHAR(30)   NOT NULL DEFAULT 'delivered',
        is_deleted            BOOLEAN       NOT NULL DEFAULT false,
        created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 22. message_attachments ---------------------------------------------
    // Platform CDN links expire, so anything worth keeping is copied to our own
    // storage and served from storage_key afterwards.
    await q.query(`
      CREATE TABLE message_attachments (
        id              BIGSERIAL     PRIMARY KEY,
        message_id      BIGINT        NOT NULL,
        enterprise_id   BIGINT        NOT NULL,
        media_kind      VARCHAR(30)   NOT NULL,
        source_url      TEXT,
        storage_key     TEXT,
        thumbnail_url   TEXT,
        thumbnail_key   TEXT,
        file_name       VARCHAR(255),
        mime_type       VARCHAR(100),
        file_size_bytes BIGINT,
        width           INTEGER,
        height          INTEGER,
        duration_ms     INTEGER,
        sort_order      INTEGER       NOT NULL DEFAULT 0,
        is_downloaded   BOOLEAN       NOT NULL DEFAULT false,
        downloaded_at   TIMESTAMPTZ,
        metadata        JSONB         NOT NULL DEFAULT '{}',
        status          VARCHAR(30)   NOT NULL DEFAULT 'active',
        is_deleted      BOOLEAN       NOT NULL DEFAULT false,
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 23. inbound_events --------------------------------------------------
    // The transport ledger. No ref_id by design: internal, never addressed by a
    // client, and a UUID plus its index on the highest-volume table is pure
    // write cost. priority is SMALLINT because the claim index ORDERS on it.
    await q.query(`
      CREATE TABLE inbound_events (
        id                    BIGSERIAL     PRIMARY KEY,
        enterprise_id         BIGINT,
        channel_id            BIGINT,
        source_kind           VARCHAR(50)   NOT NULL,
        source_id             VARCHAR(255),
        platform              VARCHAR(30)   NOT NULL,
        event_type            VARCHAR(50)   NOT NULL,
        platform_event_id     VARCHAR(255),
        dedup_key             VARCHAR(200)  NOT NULL,
        correlation_id        VARCHAR(100),
        causation_id          VARCHAR(100),
        trace_id              VARCHAR(64),
        source_sequence       BIGINT,
        schema_version        SMALLINT      NOT NULL DEFAULT 1,
        payload               JSONB         NOT NULL DEFAULT '{}',
        payload_bytes         INTEGER,
        payload_storage_key   TEXT,
        metadata              JSONB         NOT NULL DEFAULT '{}',
        priority              SMALLINT      NOT NULL DEFAULT 30,
        status                VARCHAR(30)   NOT NULL DEFAULT 'pending',
        lease_owner           VARCHAR(100),
        lease_expires_at      TIMESTAMPTZ,
        attempt_count         INTEGER       NOT NULL DEFAULT 0,
        max_attempts          INTEGER       NOT NULL DEFAULT 3,
        next_attempt_at       TIMESTAMPTZ,
        last_error            TEXT,
        last_error_at         TIMESTAMPTZ,
        dead_lettered_at      TIMESTAMPTZ,
        processing_started_at TIMESTAMPTZ,
        processed_at          TIMESTAMPTZ,
        received_at           TIMESTAMPTZ,
        is_deleted            BOOLEAN       NOT NULL DEFAULT false,
        created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 24. outbound_events -------------------------------------------------
    // Mirrors §23 except: destination_kind/destination_id replace source_*,
    // scheduled_at/sent_at replace received_at/processing_started_at/processed_at.
    await q.query(`
      CREATE TABLE outbound_events (
        id                    BIGSERIAL     PRIMARY KEY,
        enterprise_id         BIGINT,
        channel_id            BIGINT,
        destination_kind      VARCHAR(50)   NOT NULL,
        destination_id        VARCHAR(255),
        platform              VARCHAR(30)   NOT NULL,
        event_type            VARCHAR(50)   NOT NULL,
        in_reply_to_event_id  BIGINT,
        recipient_platform_id VARCHAR(255),
        platform_event_id     VARCHAR(255),
        dedup_key             VARCHAR(200)  NOT NULL,
        correlation_id        VARCHAR(100),
        causation_id          VARCHAR(100),
        trace_id              VARCHAR(64),
        source_sequence       BIGINT,
        schema_version        SMALLINT      NOT NULL DEFAULT 1,
        payload               JSONB         NOT NULL DEFAULT '{}',
        payload_bytes         INTEGER,
        payload_storage_key   TEXT,
        metadata              JSONB         NOT NULL DEFAULT '{}',
        priority              SMALLINT      NOT NULL DEFAULT 30,
        status                VARCHAR(30)   NOT NULL DEFAULT 'pending',
        lease_owner           VARCHAR(100),
        lease_expires_at      TIMESTAMPTZ,
        attempt_count         INTEGER       NOT NULL DEFAULT 0,
        max_attempts          INTEGER       NOT NULL DEFAULT 3,
        next_attempt_at       TIMESTAMPTZ,
        last_error            TEXT,
        last_error_at         TIMESTAMPTZ,
        dead_lettered_at      TIMESTAMPTZ,
        scheduled_at          TIMESTAMPTZ,
        sent_at               TIMESTAMPTZ,
        is_deleted            BOOLEAN       NOT NULL DEFAULT false,
        created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    // --- 25. audit_logs ------------------------------------------------------
    // Append-only by policy AND by grant (section 8). updated_at is a tamper
    // tripwire, not a working column: on every legitimate row it equals
    // created_at forever.
    await q.query(`
      CREATE TABLE audit_logs (
        id                BIGSERIAL     PRIMARY KEY,
        enterprise_id     BIGINT,
        actor_identity_id BIGINT,
        actor_employee_id   BIGINT,
        actor_staff_id    BIGINT,
        actor_kind        VARCHAR(30)   NOT NULL,
        is_impersonated   BOOLEAN       NOT NULL DEFAULT false,
        action            VARCHAR(50)   NOT NULL,
        entity_type       VARCHAR(50)   NOT NULL,
        entity_id         BIGINT,
        changes           JSONB         NOT NULL DEFAULT '{}',
        metadata          JSONB         NOT NULL DEFAULT '{}',
        ip_address        INET,
        user_agent        TEXT,
        status            VARCHAR(30)   NOT NULL DEFAULT 'success',
        is_deleted        BOOLEAN       NOT NULL DEFAULT false,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    await applyPostTableObjects(run);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Dropping in reverse dependency order. CASCADE is deliberately NOT used:
    // an unexpected dependency should fail loudly rather than be destroyed.
    for (const table of DROP_ORDER) {
      await q.query(`DROP TABLE IF EXISTS ${table}`);
    }
    await q.query(`DROP FUNCTION IF EXISTS set_updated_at()`);
  }
}

/*
 * Reverse dependency order. CASCADE is deliberately not used, so this order has
 * to be right: customer_engagements references conversations, and verifications
 * references customers and customer_identifiers, so those dependents must go
 * first.
 */
const DROP_ORDER = [
  'audit_logs',
  /*
   * oauth_states was MISSING from this list while up() created it, which made
   * the down() worse than destructive: a revert left the table behind, and the
   * next migrate aborted on 42P07 inside `transaction: 'all'`, so the database
   * could neither move forward nor back. It references enterprises and
   * enterprise_employees, so it goes before both.
   */
  'oauth_states',
  'message_attachments',
  'messages',
  'verifications',
  'customer_engagements',
  'conversations',
  'posts',
  'customer_identifiers',
  'customers',
  'outbound_events',
  'inbound_events',
  'sync_jobs',
  'channels',
  'provider_connections',
  'sessions',
  'enterprise_features',
  'employee_roles',
  'role_permissions',
  'permissions',
  'roles',
  'features',
  'staff_members',
  'enterprise_employees',
  'identities',
  'enterprises',
] as const;
