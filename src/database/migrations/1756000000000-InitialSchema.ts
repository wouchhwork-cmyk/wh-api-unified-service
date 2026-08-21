import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The V1 schema, exactly as docs/schema.md defines it.
 *
 * Hand-written SQL, never generated: the schema depends on partial unique
 * indexes, expression indexes, composite foreign keys routed through
 * enterprise_id, CHECK constraints, and gin_trgm_ops — none of which TypeORM's
 * synchroniser can represent. This file is the authority; entities carry columns
 * only (backend-design.md §5.1).
 *
 * Ordered in sections so dependencies resolve:
 *   1. extensions + the updated_at trigger function
 *   2. every CREATE TABLE (columns and primary keys only)
 *   3. unique indexes — including the (id, enterprise_id) parent keys, which
 *      MUST exist before any composite foreign key references them
 *   4. foreign keys
 *   5. supporting indexes
 *   6. CHECK constraints
 *   7. updated_at triggers
 *   8. audit_logs write restriction
 */
export class InitialSchema1756000000000 implements MigrationInterface {
  name = 'InitialSchema1756000000000';

  public async up(q: QueryRunner): Promise<void> {
    // =======================================================================
    // 1. Extensions and the updated_at trigger function
    // =======================================================================
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await q.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    // schema.md: every table has a trigger-maintained updated_at. Doing it in
    // the database means a write that bypasses the ORM still stamps it — which
    // is what makes audit_logs' updated_at usable as a tamper tripwire.
    await q.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

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

    // --- 3. enterprise_members --------------------------------------------
    await q.query(`
      CREATE TABLE enterprise_members (
        id                    BIGSERIAL    PRIMARY KEY,
        ref_id                UUID         NOT NULL DEFAULT gen_random_uuid(),
        identity_id           BIGINT       NOT NULL,
        enterprise_id         BIGINT       NOT NULL,
        member_kind           VARCHAR(30)  NOT NULL DEFAULT 'enterprise',
        status                VARCHAR(30)  NOT NULL DEFAULT 'invited',
        invited_by_member_id  BIGINT,
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

    // --- 8. member_roles --------------------------------------------------
    // enterprise_id is denormalised so both foreign keys can route through it.
    await q.query(`
      CREATE TABLE member_roles (
        id                   BIGSERIAL   PRIMARY KEY,
        enterprise_id        BIGINT      NOT NULL,
        member_id            BIGINT      NOT NULL,
        role_id              BIGINT      NOT NULL,
        granted_by_member_id BIGINT,
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
        requested_by_member_id BIGINT,
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
        connected_by_member_id BIGINT,
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
    // blocked_at / blocked_by_member_id / block_reason are audit trail only.
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
        blocked_by_member_id    BIGINT,
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
        authored_by_member_id  BIGINT,
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
        assigned_to_member_id  BIGINT,
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
        sent_by_member_id     BIGINT,
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
        actor_member_id   BIGINT,
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

    // =======================================================================
    // 3. Unique indexes
    //
    // The (id, enterprise_id) keys come FIRST: a composite foreign key requires
    // a unique constraint on exactly those columns in the parent, so these must
    // exist before section 4 runs.
    // =======================================================================

    // --- tenant-safety parent keys ----------------------------------------
    await q.query(`CREATE UNIQUE INDEX enterprise_members_id_enterprise_uniq ON enterprise_members (id, enterprise_id)`);
    await q.query(`CREATE UNIQUE INDEX roles_id_enterprise_uniq ON roles (id, enterprise_id)`);
    await q.query(`CREATE UNIQUE INDEX provider_connections_id_enterprise_uniq ON provider_connections (id, enterprise_id)`);
    await q.query(`CREATE UNIQUE INDEX channels_id_enterprise_uniq ON channels (id, enterprise_id)`);
    await q.query(`CREATE UNIQUE INDEX customers_id_enterprise_uniq ON customers (id, enterprise_id)`);
    await q.query(`CREATE UNIQUE INDEX customer_identifiers_id_enterprise_uniq ON customer_identifiers (id, enterprise_id)`);
    await q.query(`CREATE UNIQUE INDEX conversations_id_enterprise_uniq ON conversations (id, enterprise_id)`);

    // --- ref_id: random, never reused, so a plain UNIQUE is correct --------
    for (const table of REF_ID_TABLES) {
      await q.query(`CREATE UNIQUE INDEX ${table}_ref_id_uniq ON ${table} (ref_id)`);
    }

    // --- reusable business identifiers: partial, so deleting frees the key --
    await q.query(`CREATE UNIQUE INDEX enterprises_slug_uniq ON enterprises (slug) WHERE is_deleted = false`);
    await q.query(`CREATE UNIQUE INDEX features_key_uniq ON features ("key") WHERE is_deleted = false`);
    await q.query(`CREATE UNIQUE INDEX permissions_code_uniq ON permissions (code) WHERE is_deleted = false`);
    await q.query(`
      CREATE UNIQUE INDEX roles_enterprise_name_uniq ON roles (enterprise_id, name)
      WHERE is_deleted = false AND enterprise_id IS NOT NULL
    `);
    // A separate index because NULL enterprise_id values do not collide above.
    await q.query(`
      CREATE UNIQUE INDEX roles_global_name_uniq ON roles (name)
      WHERE is_deleted = false AND enterprise_id IS NULL
    `);

    // --- login: case-insensitive email, canonical E.164 mobile -------------
    // The query MUST be WHERE lower(email) = $1 to use this index; a plain
    // WHERE email = $1 would silently sequential-scan the auth path.
    await q.query(`
      CREATE UNIQUE INDEX identities_email_uniq ON identities (lower(email))
      WHERE is_deleted = false AND email IS NOT NULL
    `);
    await q.query(`
      CREATE UNIQUE INDEX identities_mobile_uniq ON identities (mobile)
      WHERE is_deleted = false AND mobile IS NOT NULL
    `);

    // --- memberships and grants -------------------------------------------
    await q.query(`
      CREATE UNIQUE INDEX enterprise_members_enterprise_identity_uniq
      ON enterprise_members (enterprise_id, identity_id) WHERE is_deleted = false
    `);
    await q.query(`
      CREATE UNIQUE INDEX staff_members_identity_uniq ON staff_members (identity_id)
      WHERE is_deleted = false
    `);
    await q.query(`
      CREATE UNIQUE INDEX role_permissions_uniq ON role_permissions (role_id, permission_id)
      WHERE is_deleted = false
    `);
    await q.query(`
      CREATE UNIQUE INDEX member_roles_uniq ON member_roles (member_id, role_id)
      WHERE is_deleted = false
    `);
    await q.query(`
      CREATE UNIQUE INDEX enterprise_features_uniq ON enterprise_features (enterprise_id, feature_id)
      WHERE is_deleted = false
    `);

    // --- sessions: a hash of a random token is never reused ----------------
    await q.query(`CREATE UNIQUE INDEX sessions_refresh_token_hash_uniq ON sessions (refresh_token_hash)`);

    // --- verifications: at most one LIVE code per subject/kind/destination --
    // Predicate uses only immutable column tests; a partial index cannot
    // reference now(). COALESCE because the subject is polymorphic and NULLs
    // would otherwise never collide.
    await q.query(`
      CREATE UNIQUE INDEX verifications_live_uniq ON verifications
        (COALESCE(identity_id, 0), COALESCE(customer_id, 0), verification_kind, destination)
      WHERE consumed_at IS NULL AND superseded_at IS NULL AND is_deleted = false
    `);

    // --- external identity keys: NO is_deleted predicate -------------------
    // Their job is to make a redelivered webhook or a re-import COLLIDE, and
    // that must hold even against a soft-deleted row. Re-import is an upsert.
    await q.query(`
      CREATE UNIQUE INDEX provider_connections_uniq
      ON provider_connections (enterprise_id, provider, provider_user_id)
    `);
    await q.query(`
      CREATE UNIQUE INDEX channels_platform_uniq
      ON channels (platform, platform_channel_id, provider_connection_id)
    `);
    await q.query(`CREATE UNIQUE INDEX posts_platform_uniq ON posts (channel_id, platform_post_id)`);
    await q.query(`
      CREATE UNIQUE INDEX conversations_thread_uniq
      ON conversations (channel_id, platform_thread_id)
    `);

    // --- customer identity resolution --------------------------------------
    // Partial on status = 'active' because identifiers get RECYCLED: a released
    // number becomes assignable to a new customer while history stays intact.
    await q.query(`
      CREATE UNIQUE INDEX customer_identifiers_value_uniq
      ON customer_identifiers (enterprise_id, identifier_kind, identifier_value)
      WHERE status = 'active' AND is_deleted = false
    `);
    // status = 'active' in the predicate, or a released-but-once-primary row
    // would block its replacement forever.
    await q.query(`
      CREATE UNIQUE INDEX customer_identifiers_primary_uniq
      ON customer_identifiers (enterprise_id, customer_id, identifier_kind)
      WHERE is_primary = true AND status = 'active' AND is_deleted = false
    `);
    await q.query(`
      CREATE UNIQUE INDEX customer_engagements_uniq
      ON customer_engagements (enterprise_id, customer_id, channel_id) WHERE is_deleted = false
    `);

    // --- messages: NULL is a real state, not a duplicate -------------------
    // Scoped to the ENTERPRISE, not the conversation: a comment id is unique
    // platform-wide, and conversation scoping would let the same comment exist
    // twice if a backfill and a webhook resolved it into different threads.
    await q.query(`
      CREATE UNIQUE INDEX messages_platform_uniq ON messages (enterprise_id, platform_message_id)
      WHERE platform_message_id IS NOT NULL
    `);
    await q.query(`
      CREATE UNIQUE INDEX messages_idempotency_uniq ON messages (enterprise_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);

    // --- the ledger idempotency guards -------------------------------------
    // COALESCE lets enterprise_id stay nullable for system events while still
    // making the key collide, which a plain composite index cannot.
    await q.query(`
      CREATE UNIQUE INDEX inbound_events_dedup_uniq
      ON inbound_events (COALESCE(enterprise_id, 0), dedup_key)
    `);
    await q.query(`
      CREATE UNIQUE INDEX outbound_events_dedup_uniq
      ON outbound_events (COALESCE(enterprise_id, 0), dedup_key)
    `);

    // --- one live sync job of a kind per channel ---------------------------
    await q.query(`
      CREATE UNIQUE INDEX sync_jobs_live_uniq ON sync_jobs (channel_id, job_kind)
      WHERE is_deleted = false
        AND status IN ('pending','running','paused','rate_limited')
    `);

    // =======================================================================
    // 4. Foreign keys
    //
    // Where a composite key exists it REPLACES the single-column reference: one
    // constraint per reference, never two. Routing through enterprise_id makes a
    // cross-tenant reference unrepresentable — the database rejects it.
    // =======================================================================
    await q.query(`
      ALTER TABLE enterprise_members
        ADD CONSTRAINT enterprise_members_identity_fk FOREIGN KEY (identity_id) REFERENCES identities (id),
        ADD CONSTRAINT enterprise_members_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT enterprise_members_invited_by_fk FOREIGN KEY (invited_by_member_id) REFERENCES enterprise_members (id)
    `);
    await q.query(`
      ALTER TABLE staff_members
        ADD CONSTRAINT staff_members_identity_fk FOREIGN KEY (identity_id) REFERENCES identities (id)
    `);
    await q.query(`
      ALTER TABLE roles
        ADD CONSTRAINT roles_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id)
    `);
    await q.query(`
      ALTER TABLE permissions
        ADD CONSTRAINT permissions_feature_fk FOREIGN KEY (feature_id) REFERENCES features (id)
    `);
    await q.query(`
      ALTER TABLE role_permissions
        ADD CONSTRAINT role_permissions_role_fk FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
        ADD CONSTRAINT role_permissions_permission_fk FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
    `);
    // THE table where cross-tenant privilege escalation would happen. Both
    // references route through enterprise_id, so pairing business A's member
    // with business B's role is rejected by the database.
    await q.query(`
      ALTER TABLE member_roles
        ADD CONSTRAINT member_roles_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT member_roles_member_fk
            FOREIGN KEY (member_id, enterprise_id) REFERENCES enterprise_members (id, enterprise_id),
        ADD CONSTRAINT member_roles_role_fk
            FOREIGN KEY (role_id, enterprise_id) REFERENCES roles (id, enterprise_id),
        ADD CONSTRAINT member_roles_granted_by_fk
            FOREIGN KEY (granted_by_member_id) REFERENCES enterprise_members (id)
    `);
    await q.query(`
      ALTER TABLE enterprise_features
        ADD CONSTRAINT enterprise_features_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT enterprise_features_feature_fk FOREIGN KEY (feature_id) REFERENCES features (id),
        ADD CONSTRAINT enterprise_features_requested_by_fk
            FOREIGN KEY (requested_by_member_id, enterprise_id) REFERENCES enterprise_members (id, enterprise_id),
        ADD CONSTRAINT enterprise_features_decided_by_fk
            FOREIGN KEY (decided_by_staff_id) REFERENCES staff_members (id)
    `);
    await q.query(`
      ALTER TABLE sessions
        ADD CONSTRAINT sessions_identity_fk FOREIGN KEY (identity_id) REFERENCES identities (id) ON DELETE CASCADE
    `);
    await q.query(`
      ALTER TABLE provider_connections
        ADD CONSTRAINT provider_connections_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT provider_connections_connected_by_fk
            FOREIGN KEY (connected_by_member_id, enterprise_id) REFERENCES enterprise_members (id, enterprise_id)
    `);
    await q.query(`
      ALTER TABLE channels
        ADD CONSTRAINT channels_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT channels_connection_fk
            FOREIGN KEY (provider_connection_id, enterprise_id)
            REFERENCES provider_connections (id, enterprise_id) ON DELETE CASCADE,
        ADD CONSTRAINT channels_parent_fk
            FOREIGN KEY (parent_channel_id, enterprise_id) REFERENCES channels (id, enterprise_id)
    `);
    await q.query(`
      ALTER TABLE sync_jobs
        ADD CONSTRAINT sync_jobs_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT sync_jobs_channel_fk
            FOREIGN KEY (channel_id, enterprise_id) REFERENCES channels (id, enterprise_id) ON DELETE CASCADE
    `);
    await q.query(`
      ALTER TABLE customers
        ADD CONSTRAINT customers_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT customers_first_channel_fk
            FOREIGN KEY (first_channel_id, enterprise_id) REFERENCES channels (id, enterprise_id),
        ADD CONSTRAINT customers_last_channel_fk
            FOREIGN KEY (last_channel_id, enterprise_id) REFERENCES channels (id, enterprise_id),
        ADD CONSTRAINT customers_blocked_by_fk
            FOREIGN KEY (blocked_by_member_id, enterprise_id) REFERENCES enterprise_members (id, enterprise_id),
        ADD CONSTRAINT customers_merged_into_fk
            FOREIGN KEY (merged_into_customer_id, enterprise_id) REFERENCES customers (id, enterprise_id)
    `);
    await q.query(`
      ALTER TABLE customer_identifiers
        ADD CONSTRAINT customer_identifiers_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT customer_identifiers_customer_fk
            FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id)
    `);
    await q.query(`
      ALTER TABLE customer_engagements
        ADD CONSTRAINT customer_engagements_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT customer_engagements_customer_fk
            FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id),
        ADD CONSTRAINT customer_engagements_channel_fk
            FOREIGN KEY (channel_id, enterprise_id) REFERENCES channels (id, enterprise_id),
        ADD CONSTRAINT customer_engagements_last_conversation_fk
            FOREIGN KEY (last_conversation_id, enterprise_id) REFERENCES conversations (id, enterprise_id)
    `);
    await q.query(`
      ALTER TABLE posts
        ADD CONSTRAINT posts_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT posts_channel_fk
            FOREIGN KEY (channel_id, enterprise_id) REFERENCES channels (id, enterprise_id) ON DELETE CASCADE,
        ADD CONSTRAINT posts_authored_by_fk
            FOREIGN KEY (authored_by_member_id, enterprise_id) REFERENCES enterprise_members (id, enterprise_id)
    `);
    await q.query(`
      ALTER TABLE conversations
        ADD CONSTRAINT conversations_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT conversations_channel_fk
            FOREIGN KEY (channel_id, enterprise_id) REFERENCES channels (id, enterprise_id),
        ADD CONSTRAINT conversations_customer_fk
            FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id),
        ADD CONSTRAINT conversations_customer_identifier_fk
            FOREIGN KEY (customer_identifier_id, enterprise_id)
            REFERENCES customer_identifiers (id, enterprise_id),
        ADD CONSTRAINT conversations_post_fk FOREIGN KEY (post_id) REFERENCES posts (id),
        ADD CONSTRAINT conversations_assigned_to_fk
            FOREIGN KEY (assigned_to_member_id, enterprise_id) REFERENCES enterprise_members (id, enterprise_id)
    `);
    await q.query(`
      ALTER TABLE messages
        ADD CONSTRAINT messages_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT messages_conversation_fk
            FOREIGN KEY (conversation_id, enterprise_id)
            REFERENCES conversations (id, enterprise_id) ON DELETE CASCADE,
        ADD CONSTRAINT messages_customer_fk
            FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id),
        ADD CONSTRAINT messages_sent_by_fk
            FOREIGN KEY (sent_by_member_id, enterprise_id) REFERENCES enterprise_members (id, enterprise_id),
        ADD CONSTRAINT messages_parent_fk FOREIGN KEY (parent_message_id) REFERENCES messages (id),
        ADD CONSTRAINT messages_inbound_event_fk FOREIGN KEY (inbound_event_id) REFERENCES inbound_events (id),
        ADD CONSTRAINT messages_outbound_event_fk FOREIGN KEY (outbound_event_id) REFERENCES outbound_events (id)
    `);
    await q.query(`
      ALTER TABLE message_attachments
        ADD CONSTRAINT message_attachments_message_fk
            FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
        ADD CONSTRAINT message_attachments_enterprise_fk
            FOREIGN KEY (enterprise_id) REFERENCES enterprises (id)
    `);
    await q.query(`
      ALTER TABLE inbound_events
        ADD CONSTRAINT inbound_events_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT inbound_events_channel_fk
            FOREIGN KEY (channel_id, enterprise_id) REFERENCES channels (id, enterprise_id)
    `);
    await q.query(`
      ALTER TABLE outbound_events
        ADD CONSTRAINT outbound_events_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT outbound_events_channel_fk
            FOREIGN KEY (channel_id, enterprise_id) REFERENCES channels (id, enterprise_id),
        ADD CONSTRAINT outbound_events_in_reply_to_fk
            FOREIGN KEY (in_reply_to_event_id) REFERENCES inbound_events (id)
    `);
    // A customer subject is tenant-scoped and its references cannot cross
    // enterprises; an identity subject is global, so enterprise_id is context only.
    await q.query(`
      ALTER TABLE verifications
        ADD CONSTRAINT verifications_identity_fk
            FOREIGN KEY (identity_id) REFERENCES identities (id) ON DELETE CASCADE,
        ADD CONSTRAINT verifications_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT verifications_customer_fk
            FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id),
        ADD CONSTRAINT verifications_identifier_fk
            FOREIGN KEY (customer_identifier_id, enterprise_id)
            REFERENCES customer_identifiers (id, enterprise_id),
        ADD CONSTRAINT verifications_outbound_event_fk
            FOREIGN KEY (outbound_event_id) REFERENCES outbound_events (id)
    `);
    await q.query(`
      ALTER TABLE audit_logs
        ADD CONSTRAINT audit_logs_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT audit_logs_actor_identity_fk FOREIGN KEY (actor_identity_id) REFERENCES identities (id),
        ADD CONSTRAINT audit_logs_actor_member_fk FOREIGN KEY (actor_member_id) REFERENCES enterprise_members (id),
        ADD CONSTRAINT audit_logs_actor_staff_fk FOREIGN KEY (actor_staff_id) REFERENCES staff_members (id)
    `);

    // =======================================================================
    // 5. Supporting indexes — the query paths schema.md names
    // =======================================================================

    // --- lookups right after password verification -------------------------
    await q.query(`CREATE INDEX enterprise_members_identity_idx ON enterprise_members (identity_id) WHERE is_deleted = false`);
    await q.query(`CREATE INDEX enterprise_members_enterprise_idx ON enterprise_members (enterprise_id) WHERE is_deleted = false`);
    await q.query(`CREATE INDEX enterprises_status_idx ON enterprises (status) WHERE is_deleted = false`);

    // --- permission resolution --------------------------------------------
    await q.query(`CREATE INDEX role_permissions_role_idx ON role_permissions (role_id) WHERE is_deleted = false`);
    await q.query(`CREATE INDEX member_roles_member_idx ON member_roles (member_id) WHERE is_deleted = false`);
    await q.query(`CREATE INDEX permissions_feature_idx ON permissions (feature_id)`);
    await q.query(`CREATE INDEX permissions_resource_idx ON permissions (resource)`);

    // --- the feature expiry sweep -----------------------------------------
    await q.query(`
      CREATE INDEX enterprise_features_expiry_idx ON enterprise_features (expires_at)
      WHERE is_deleted = false AND expires_at IS NOT NULL AND status = 'active'
    `);

    // --- sessions cleanup --------------------------------------------------
    await q.query(`CREATE INDEX sessions_identity_idx ON sessions (identity_id)`);
    await q.query(`CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL`);

    // --- verifications: rate limiting and cleanup --------------------------
    await q.query(`CREATE INDEX verifications_destination_idx ON verifications (destination, created_at DESC)`);
    await q.query(`
      CREATE INDEX verifications_expiry_idx ON verifications (expires_at)
      WHERE consumed_at IS NULL AND is_deleted = false
    `);
    await q.query(`CREATE INDEX verifications_identity_idx ON verifications (identity_id)`);
    await q.query(`CREATE INDEX verifications_customer_idx ON verifications (enterprise_id, customer_id)`);

    // --- token expiry sweeps ----------------------------------------------
    await q.query(`
      CREATE INDEX provider_connections_token_expiry_idx ON provider_connections (token_expires_at)
      WHERE is_deleted = false AND token_expires_at IS NOT NULL AND status = 'active'
    `);
    await q.query(`CREATE INDEX provider_connections_enterprise_idx ON provider_connections (enterprise_id) WHERE is_deleted = false`);
    await q.query(`
      CREATE INDEX channels_token_expiry_idx ON channels (token_expires_at)
      WHERE is_deleted = false AND token_expires_at IS NOT NULL AND status = 'active'
    `);
    await q.query(`CREATE INDEX channels_enterprise_idx ON channels (enterprise_id) WHERE is_deleted = false`);
    await q.query(`CREATE INDEX channels_connection_idx ON channels (provider_connection_id)`);
    await q.query(`CREATE INDEX channels_parent_idx ON channels (parent_channel_id) WHERE parent_channel_id IS NOT NULL`);

    // --- sync jobs: runnable work and lease reclaim ------------------------
    // COALESCE so a rate-limited job whose backoff has passed is FOUND; without
    // it there is no index that surfaces it and resuming needs a scan.
    await q.query(`
      CREATE INDEX sync_jobs_runnable_idx
      ON sync_jobs (COALESCE(next_attempt_at, rate_limited_until, created_at), id)
      WHERE status IN ('pending','failed','rate_limited')
    `);
    await q.query(`CREATE INDEX sync_jobs_expired_lease_idx ON sync_jobs (lease_expires_at) WHERE status = 'running'`);
    await q.query(`CREATE INDEX sync_jobs_channel_idx ON sync_jobs (channel_id)`);

    // --- the customer directory and search --------------------------------
    await q.query(`
      CREATE INDEX customers_directory_idx ON customers (enterprise_id, last_seen_at DESC, id)
      WHERE is_deleted = false
    `);
    // Trigram on display_name alone: BIGINT has no GIN operator class, so a
    // composite (enterprise_id, display_name) GIN index would additionally need
    // btree_gin. The tenant filter combines as a bitmap AND instead.
    await q.query(`CREATE INDEX customers_name_trgm_idx ON customers USING gin (display_name gin_trgm_ops)`);

    // --- customer identifiers ---------------------------------------------
    await q.query(`
      CREATE INDEX customer_identifiers_customer_idx
      ON customer_identifiers (enterprise_id, customer_id) WHERE is_deleted = false
    `);
    // Agents search a phone the way it is written locally ("9876543210", no
    // country). Only possible because national_number is a physical column — a
    // suffix match on the E.164 string would be unindexable.
    await q.query(`
      CREATE INDEX customer_identifiers_national_idx
      ON customer_identifiers (enterprise_id, national_number)
      WHERE national_number IS NOT NULL AND status = 'active' AND is_deleted = false
    `);

    // --- engagement segments ----------------------------------------------
    await q.query(`
      CREATE INDEX customer_engagements_platform_idx
      ON customer_engagements (enterprise_id, platform, last_engaged_at DESC) WHERE is_deleted = false
    `);
    await q.query(`
      CREATE INDEX customer_engagements_channel_idx
      ON customer_engagements (enterprise_id, channel_id, last_engaged_at DESC) WHERE is_deleted = false
    `);

    // --- the posts feed ---------------------------------------------------
    await q.query(`
      CREATE INDEX posts_feed_idx ON posts (enterprise_id, channel_id, published_at DESC, id)
      WHERE is_deleted = false
    `);

    // --- the inbox --------------------------------------------------------
    await q.query(`
      CREATE INDEX conversations_inbox_idx
      ON conversations (enterprise_id, status, last_message_at DESC, id) WHERE is_deleted = false
    `);
    await q.query(`
      CREATE INDEX conversations_assignee_idx
      ON conversations (assigned_to_member_id, status, last_message_at DESC) WHERE is_deleted = false
    `);
    await q.query(`
      CREATE INDEX conversations_post_idx ON conversations (post_id, last_message_at DESC)
      WHERE is_deleted = false
    `);
    await q.query(`
      CREATE INDEX conversations_customer_idx
      ON conversations (enterprise_id, customer_id, last_message_at DESC) WHERE is_deleted = false
    `);

    // --- reading a thread, and the delivery write-back --------------------
    // COALESCE: internal notes and still-queued sends have no platform
    // timestamp and must interleave by creation time, not sink to the end.
    await q.query(`
      CREATE INDEX messages_thread_idx
      ON messages (conversation_id, COALESCE(platform_sent_at, created_at), id) WHERE is_deleted = false
    `);
    await q.query(`CREATE INDEX messages_outbound_event_idx ON messages (outbound_event_id)`);
    await q.query(`CREATE INDEX messages_inbound_event_idx ON messages (inbound_event_id)`);
    await q.query(`
      CREATE INDEX messages_unread_idx ON messages (enterprise_id, conversation_id)
      WHERE is_deleted = false AND direction = 'inbound' AND is_read = false
    `);
    await q.query(`CREATE INDEX messages_customer_idx ON messages (enterprise_id, customer_id)`);
    await q.query(`CREATE INDEX messages_parent_idx ON messages (parent_message_id) WHERE parent_message_id IS NOT NULL`);

    // --- attachments: the download worker ---------------------------------
    await q.query(`CREATE INDEX message_attachments_message_idx ON message_attachments (message_id)`);
    await q.query(`
      CREATE INDEX message_attachments_pending_idx ON message_attachments (id)
      WHERE is_downloaded = false AND status = 'active' AND is_deleted = false
    `);

    // --- the ledger claim scans -------------------------------------------
    // Ordered on (priority, due-time, id): priority is numeric so smaller runs
    // sooner, and COALESCE keeps a brand-new event from sorting behind every
    // retrying row.
    await q.query(`
      CREATE INDEX inbound_events_claimable_idx
      ON inbound_events (priority, COALESCE(next_attempt_at, created_at), id)
      WHERE status IN ('pending','failed')
    `);
    await q.query(`
      CREATE INDEX inbound_events_expired_lease_idx ON inbound_events (lease_expires_at)
      WHERE status IN ('leased','processing')
    `);
    await q.query(`CREATE INDEX inbound_events_enterprise_idx ON inbound_events (enterprise_id, created_at DESC)`);
    await q.query(`
      CREATE INDEX inbound_events_dead_letter_idx ON inbound_events (dead_lettered_at DESC)
      WHERE status = 'dead_letter'
    `);
    await q.query(`
      CREATE INDEX outbound_events_due_idx
      ON outbound_events (priority, COALESCE(next_attempt_at, scheduled_at, created_at), id)
      WHERE status IN ('pending','scheduled','failed')
    `);
    await q.query(`
      CREATE INDEX outbound_events_expired_lease_idx ON outbound_events (lease_expires_at)
      WHERE status IN ('leased','sending')
    `);
    await q.query(`CREATE INDEX outbound_events_enterprise_idx ON outbound_events (enterprise_id, created_at DESC)`);
    await q.query(`
      CREATE INDEX outbound_events_dead_letter_idx ON outbound_events (dead_lettered_at DESC)
      WHERE status = 'dead_letter'
    `);

    // --- the audit trail --------------------------------------------------
    await q.query(`CREATE INDEX audit_logs_enterprise_idx ON audit_logs (enterprise_id, created_at DESC)`);
    await q.query(`CREATE INDEX audit_logs_actor_identity_idx ON audit_logs (actor_identity_id, created_at DESC)`);
    await q.query(`CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id)`);
    await q.query(`CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC)`);
    // The question a customer will eventually ask: which Wouchh staff touched
    // my data, and when.
    await q.query(`
      CREATE INDEX audit_logs_staff_access_idx
      ON audit_logs (enterprise_id, actor_staff_id, created_at DESC) WHERE actor_staff_id IS NOT NULL
    `);

    // =======================================================================
    // 6. CHECK constraints
    //
    // schema.md validates ENUM VALUES in application code, deliberately, so a
    // new state is a code change rather than a migration. These two are not
    // value lists — they are structural invariants that will never change.
    // =======================================================================

    // A row with neither credential can never be found by any login query, can
    // never be reached by password reset, and produces no error when created.
    await q.query(`
      ALTER TABLE identities
        ADD CONSTRAINT identities_has_credential_chk
        CHECK (email IS NOT NULL OR mobile IS NOT NULL)
    `);

    // Exactly one subject, never both, never neither. A customer subject is
    // additionally required to be tenant-scoped.
    await q.query(`
      ALTER TABLE verifications
        ADD CONSTRAINT verifications_subject_chk CHECK (
              (subject_kind = 'identity' AND identity_id IS NOT NULL AND customer_id IS NULL)
           OR (subject_kind = 'customer' AND customer_id IS NOT NULL AND identity_id IS NULL
                                         AND enterprise_id IS NOT NULL)
        )
    `);

    // =======================================================================
    // 7. updated_at triggers
    // =======================================================================
    for (const table of ALL_TABLES) {
      await q.query(`
        CREATE TRIGGER ${table}_set_updated_at
        BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
      `);
    }

    // =======================================================================
    // 8. audit_logs is append-only in the DATABASE, not just by policy
    //
    // Policy is not enforcement. With UPDATE and DELETE revoked, the updated_at
    // tripwire can only ever fire on something with elevated access — which is
    // exactly the case worth knowing about.
    //
    // Applied only when the application role is distinct from the migration
    // role; in dev they are the same user and revoking would break the trigger.
    // =======================================================================
    await q.query(`
      DO $$
      DECLARE app_role text := current_setting('wouchh.app_role', true);
      BEGIN
        IF app_role IS NOT NULL AND app_role <> '' AND app_role <> current_user THEN
          EXECUTE format('REVOKE UPDATE, DELETE ON audit_logs FROM %I', app_role);
          EXECUTE format('GRANT INSERT, SELECT ON audit_logs TO %I', app_role);
        END IF;
      END $$
    `);
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

/** Tables a client can address, and therefore carrying ref_id. */
const REF_ID_TABLES = [
  'enterprises',
  'identities',
  'enterprise_members',
  'staff_members',
  'roles',
  'permissions',
  'features',
  'enterprise_features',
  'verifications',
  'provider_connections',
  'channels',
  'sync_jobs',
  'customers',
  'posts',
  'conversations',
  'messages',
] as const;

/** Every table, for the updated_at trigger loop. */
const ALL_TABLES = [
  ...REF_ID_TABLES,
  'role_permissions',
  'member_roles',
  'sessions',
  'customer_identifiers',
  'customer_engagements',
  'message_attachments',
  'inbound_events',
  'outbound_events',
  'audit_logs',
] as const;

const DROP_ORDER = [
  'audit_logs',
  'message_attachments',
  'messages',
  'conversations',
  'posts',
  'customer_engagements',
  'customer_identifiers',
  'customers',
  'verifications',
  'outbound_events',
  'inbound_events',
  'sync_jobs',
  'channels',
  'provider_connections',
  'sessions',
  'enterprise_features',
  'member_roles',
  'role_permissions',
  'permissions',
  'roles',
  'features',
  'staff_members',
  'enterprise_members',
  'identities',
  'enterprises',
] as const;
