/**
 * Everything the schema needs that is NOT a CREATE TABLE.
 *
 * 88 statements: two extensions, the updated_at trigger function, 34 unique
 * indexes, 69 foreign keys, 55 supporting indexes, 2 CHECK constraints, the
 * per-table updated_at triggers, and the grant that makes audit_logs
 * append-only in the database rather than merely by policy.
 *
 * THIS FILE EXISTS BECAUSE TYPEORM'S SYNCHRONISER CANNOT EXPRESS ANY OF IT.
 * Partial unique indexes, expression indexes, composite foreign keys routed
 * through enterprise_id, CHECK constraints, gin_trgm_ops, REVOKE — entity
 * metadata has no way to say any of these things. Run `synchronize` against a
 * database built by the migration and it emits 176 statements, of which 103 are
 * DROP INDEX and 69 are DROP CONSTRAINT: it would demolish every guarantee in
 * the schema and leave a database that still boots.
 *
 * So both paths into a database go through here:
 *
 *   - the migration (the authority for qa and prod) calls it around its own
 *     CREATE TABLE block
 *   - `pnpm db:sync` (dev only) lets TypeORM create and alter the tables to
 *     match the entities, then calls it to put everything else back
 *
 * ONE source, so the two cannot drift. The equivalence test in
 * test/integration/schema-parity.spec.ts proves they agree.
 */

/**
 * Runs one statement. The migration passes a plain query; the sync path passes
 * one that tolerates an object that already exists, since it re-applies over a
 * live database.
 */
export type SqlRunner = (sql: string) => Promise<unknown>;

/** Tables a client can address, and therefore carrying ref_id. */
export const REF_ID_TABLES = [
  'enterprises',
  'identities',
  'enterprise_employees',
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
export const ALL_TABLES = [
  ...REF_ID_TABLES,
  'role_permissions',
  'employee_roles',
  'sessions',
  'customer_identifiers',
  'customer_engagements',
  'message_attachments',
  'inbound_events',
  'outbound_events',
  'audit_logs',
] as const;

/**
 * Extensions and the trigger FUNCTION. Must run BEFORE any table: pg_trgm has
 * to exist before an index can name gin_trgm_ops, and the function has to exist
 * before a trigger can reference it.
 */
export async function applyPreTableObjects(run: SqlRunner): Promise<void> {
  // 1. Extensions and the updated_at trigger function
  // =======================================================================
  await run(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await run(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  // schema.md: every table has a trigger-maintained updated_at. Doing it in
  // the database means a write that bypasses the ORM still stamps it — which
  // is what makes audit_logs' updated_at usable as a tamper tripwire.
  await run(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
}

/**
 * Everything after the tables, in dependency order. The order is not cosmetic:
 * the (id, enterprise_id) parent unique keys in section 3 MUST exist before the
 * composite foreign keys in section 4 can reference them.
 */
export async function applyPostTableObjects(
  run: SqlRunner,
  options: { appRole?: string | null } = {},
): Promise<void> {
  /*
   * THE APPLICATION ROLE, SET RATHER THAN ASSUMED.
   *
   * The append-only grant at the end of this function reads
   * `current_setting('wouchh.app_role')`, and nothing in the repository ever set
   * it — so the control was inert in every environment while reading, in the
   * schema, as though it were in force. It is set here from configuration, so
   * naming a distinct DB_APP_ROLE makes it real and leaving it unset leaves it
   * honestly absent.
   *
   * set_config with `is_local = false` so it survives to the end of this run
   * whether or not the caller wrapped it in a transaction.
   */
  if (options.appRole) {
    await run(
      `SELECT set_config('wouchh.app_role', '${options.appRole.replace(/'/g, "''")}', false)`,
    );
  }

  // 3. Unique indexes
  //
  // The (id, enterprise_id) keys come FIRST: a composite foreign key requires
  // a unique constraint on exactly those columns in the parent, so these must
  // exist before section 4 runs.
  // =======================================================================

  // --- tenant-safety parent keys ----------------------------------------
  await run(
    `CREATE UNIQUE INDEX enterprise_employees_id_enterprise_uniq ON enterprise_employees (id, enterprise_id)`,
  );
  await run(`CREATE UNIQUE INDEX roles_id_enterprise_uniq ON roles (id, enterprise_id)`);
  await run(
    `CREATE UNIQUE INDEX provider_connections_id_enterprise_uniq ON provider_connections (id, enterprise_id)`,
  );
  await run(`CREATE UNIQUE INDEX channels_id_enterprise_uniq ON channels (id, enterprise_id)`);
  await run(`CREATE UNIQUE INDEX customers_id_enterprise_uniq ON customers (id, enterprise_id)`);
  await run(
    `CREATE UNIQUE INDEX customer_identifiers_id_enterprise_uniq ON customer_identifiers (id, enterprise_id)`,
  );
  await run(
    `CREATE UNIQUE INDEX conversations_id_enterprise_uniq ON conversations (id, enterprise_id)`,
  );

  // --- ref_id: random, never reused, so a plain UNIQUE is correct --------
  for (const table of REF_ID_TABLES) {
    await run(`CREATE UNIQUE INDEX ${table}_ref_id_uniq ON ${table} (ref_id)`);
  }

  // --- reusable business identifiers: partial, so deleting frees the key --
  await run(
    `CREATE UNIQUE INDEX enterprises_slug_uniq ON enterprises (slug) WHERE is_deleted = false`,
  );
  /*
   * ONE BUSINESS PER CONTACT ADDRESS.
   *
   * Signup is the only way a business comes into existence, and there is no way
   * to sign up INTO an existing one — so without this, two colleagues signing up
   * "Acme Coffee" get two separate tenants with two separate slugs, split data,
   * and a product that looks broken rather than duplicated. The second person has
   * to be given an account by the first, which is what this forces.
   *
   * lower(), because a business is not two businesses for having capitalised its
   * own address.
   */
  await run(
    `CREATE UNIQUE INDEX enterprises_email_uniq ON enterprises (lower(email)) WHERE is_deleted = false`,
  );
  await run(`CREATE UNIQUE INDEX features_key_uniq ON features ("key") WHERE is_deleted = false`);
  await run(
    `CREATE UNIQUE INDEX permissions_code_uniq ON permissions (code) WHERE is_deleted = false`,
  );
  await run(`
      CREATE UNIQUE INDEX roles_enterprise_name_uniq ON roles (enterprise_id, name)
      WHERE is_deleted = false AND enterprise_id IS NOT NULL
    `);
  // A separate index because NULL enterprise_id values do not collide above.
  await run(`
      CREATE UNIQUE INDEX roles_global_name_uniq ON roles (name)
      WHERE is_deleted = false AND enterprise_id IS NULL
    `);

  // --- login: case-insensitive email, canonical E.164 mobile -------------
  // The query MUST be WHERE lower(email) = $1 to use this index; a plain
  // WHERE email = $1 would silently sequential-scan the auth path.
  await run(`
      CREATE UNIQUE INDEX identities_email_uniq ON identities (lower(email))
      WHERE is_deleted = false AND email IS NOT NULL
    `);
  await run(`
      CREATE UNIQUE INDEX identities_mobile_uniq ON identities (mobile)
      WHERE is_deleted = false AND mobile IS NOT NULL
    `);

  // --- employments and grants -------------------------------------------
  await run(`
      CREATE UNIQUE INDEX enterprise_employees_enterprise_identity_uniq
      ON enterprise_employees (enterprise_id, identity_id) WHERE is_deleted = false
    `);
  await run(`
      CREATE UNIQUE INDEX staff_members_identity_uniq ON staff_members (identity_id)
      WHERE is_deleted = false
    `);
  await run(`
      CREATE UNIQUE INDEX role_permissions_uniq ON role_permissions (role_id, permission_id)
      WHERE is_deleted = false
    `);
  await run(`
      CREATE UNIQUE INDEX employee_roles_uniq ON employee_roles (employee_id, role_id)
      WHERE is_deleted = false
    `);
  await run(`
      CREATE UNIQUE INDEX enterprise_features_uniq ON enterprise_features (enterprise_id, feature_id)
      WHERE is_deleted = false
    `);

  // --- sessions: a hash of a random token is never reused ----------------
  await run(
    `CREATE UNIQUE INDEX sessions_refresh_token_hash_uniq ON sessions (refresh_token_hash)`,
  );

  // --- verifications: at most one LIVE code per subject/kind/destination --
  // Predicate uses only immutable column tests; a partial index cannot
  // reference now(). COALESCE because the subject is polymorphic and NULLs
  // would otherwise never collide.
  await run(`
      CREATE UNIQUE INDEX verifications_live_uniq ON verifications
        (COALESCE(identity_id, 0), COALESCE(customer_id, 0), verification_kind, destination)
      WHERE consumed_at IS NULL AND superseded_at IS NULL AND is_deleted = false
    `);

  // --- external identity keys: NO is_deleted predicate -------------------
  // Their job is to make a redelivered webhook or a re-import COLLIDE, and
  // that must hold even against a soft-deleted row. Re-import is an upsert.
  await run(`
      CREATE UNIQUE INDEX provider_connections_uniq
      ON provider_connections (enterprise_id, provider, provider_user_id)
    `);
  await run(`
      CREATE UNIQUE INDEX channels_platform_uniq
      ON channels (platform, platform_channel_id, provider_connection_id)
    `);
  await run(`CREATE UNIQUE INDEX posts_platform_uniq ON posts (channel_id, platform_post_id)`);
  await run(`
      CREATE UNIQUE INDEX conversations_thread_uniq
      ON conversations (channel_id, platform_thread_id)
    `);

  /*
   * FINDING A MENTION BY THE COMMENT IT IS ABOUT.
   *
   * A mention stores the comment it replies to as `mentionParentId`, and when
   * that parent ALSO tagged us we already hold it as a conversation of its own.
   * Resolving one to the other is a thread-read, which is a hot path — and the
   * key lives inside jsonb, so without an expression index this is a sequential
   * scan of every conversation the business has.
   *
   * Partial on the kind: only a mention carries this key, so the index stays
   * the size of the mention population rather than the whole table.
   */
  await run(`
      CREATE INDEX conversations_mention_comment_idx
      ON conversations ((context_metadata->>'mentionedCommentId'))
      WHERE conversation_kind = 'mention' AND is_deleted = false
    `);

  // --- customer identity resolution --------------------------------------
  // Partial on status = 'active' because identifiers get RECYCLED: a released
  // number becomes assignable to a new customer while history stays intact.
  await run(`
      CREATE UNIQUE INDEX customer_identifiers_value_uniq
      ON customer_identifiers (enterprise_id, identifier_kind, identifier_value)
      WHERE status = 'active' AND is_deleted = false
    `);
  // status = 'active' in the predicate, or a released-but-once-primary row
  // would block its replacement forever.
  await run(`
      CREATE UNIQUE INDEX customer_identifiers_primary_uniq
      ON customer_identifiers (enterprise_id, customer_id, identifier_kind)
      WHERE is_primary = true AND status = 'active' AND is_deleted = false
    `);
  await run(`
      CREATE UNIQUE INDEX customer_engagements_uniq
      ON customer_engagements (enterprise_id, customer_id, channel_id) WHERE is_deleted = false
    `);

  // --- messages: NULL is a real state, not a duplicate -------------------
  // Scoped to the ENTERPRISE, not the conversation: a comment id is unique
  // platform-wide, and conversation scoping would let the same comment exist
  // twice if a backfill and a webhook resolved it into different threads.
  await run(`
      CREATE UNIQUE INDEX messages_platform_uniq ON messages (enterprise_id, platform_message_id)
      WHERE platform_message_id IS NOT NULL
    `);
  await run(`
      CREATE UNIQUE INDEX messages_idempotency_uniq ON messages (enterprise_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);

  // --- the ledger idempotency guards -------------------------------------
  // COALESCE lets enterprise_id stay nullable for system events while still
  // making the key collide, which a plain composite index cannot.
  await run(`
      CREATE UNIQUE INDEX inbound_events_dedup_uniq
      ON inbound_events (COALESCE(enterprise_id, 0), dedup_key)
    `);
  await run(`
      CREATE UNIQUE INDEX outbound_events_dedup_uniq
      ON outbound_events (COALESCE(enterprise_id, 0), dedup_key)
    `);

  // --- one live sync job of a kind per channel, per target ---------------
  /*
   * COALESCE, not the bare column: a unique index treats every NULL as
   * distinct, so `(channel_id, job_kind, target_platform_id)` would let an
   * unlimited number of channel-wide backfills queue up — the exact thing this
   * index exists to prevent. Empty string stands in for "the whole channel",
   * which no platform id can collide with.
   */
  await run(`
      CREATE UNIQUE INDEX sync_jobs_live_uniq
      ON sync_jobs (channel_id, job_kind, COALESCE(target_platform_id, ''))
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
  await run(`
      ALTER TABLE enterprise_employees
        ADD CONSTRAINT enterprise_employees_identity_fk FOREIGN KEY (identity_id) REFERENCES identities (id),
        ADD CONSTRAINT enterprise_employees_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT enterprise_employees_invited_by_fk FOREIGN KEY (invited_by_employee_id) REFERENCES enterprise_employees (id)
    `);
  await run(`
      ALTER TABLE staff_members
        ADD CONSTRAINT staff_members_identity_fk FOREIGN KEY (identity_id) REFERENCES identities (id)
    `);
  await run(`
      ALTER TABLE roles
        ADD CONSTRAINT roles_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id)
    `);
  await run(`
      ALTER TABLE permissions
        ADD CONSTRAINT permissions_feature_fk FOREIGN KEY (feature_id) REFERENCES features (id)
    `);
  await run(`
      ALTER TABLE role_permissions
        ADD CONSTRAINT role_permissions_role_fk FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
        ADD CONSTRAINT role_permissions_permission_fk FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
    `);
  // THE table where cross-tenant privilege escalation would happen. Both
  // references route through enterprise_id, so pairing business A's employee
  // with business B's role is rejected by the database.
  await run(`
      ALTER TABLE employee_roles
        ADD CONSTRAINT employee_roles_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT employee_roles_employee_fk
            FOREIGN KEY (employee_id, enterprise_id) REFERENCES enterprise_employees (id, enterprise_id),
        ADD CONSTRAINT employee_roles_role_fk
            FOREIGN KEY (role_id, enterprise_id) REFERENCES roles (id, enterprise_id),
        ADD CONSTRAINT employee_roles_granted_by_fk
            FOREIGN KEY (granted_by_employee_id) REFERENCES enterprise_employees (id)
    `);
  await run(`
      ALTER TABLE enterprise_features
        ADD CONSTRAINT enterprise_features_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT enterprise_features_feature_fk FOREIGN KEY (feature_id) REFERENCES features (id),
        ADD CONSTRAINT enterprise_features_requested_by_fk
            FOREIGN KEY (requested_by_employee_id, enterprise_id) REFERENCES enterprise_employees (id, enterprise_id),
        ADD CONSTRAINT enterprise_features_decided_by_fk
            FOREIGN KEY (decided_by_staff_id) REFERENCES staff_members (id)
    `);
  await run(`
      ALTER TABLE sessions
        ADD CONSTRAINT sessions_identity_fk FOREIGN KEY (identity_id) REFERENCES identities (id) ON DELETE CASCADE
    `);
  /*
   * employee_id is paired with enterprise_id in a COMPOSITE key, the same
   * discipline as everywhere else: a state row naming one business's employee
   * while claiming another business is unrepresentable, not merely discouraged.
   */
  await run(`
      ALTER TABLE oauth_states
        ADD CONSTRAINT oauth_states_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT oauth_states_employee_fk FOREIGN KEY (employee_id, enterprise_id)
            REFERENCES enterprise_employees (id, enterprise_id)
    `);
  await run(`
      ALTER TABLE provider_connections
        ADD CONSTRAINT provider_connections_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT provider_connections_connected_by_fk
            FOREIGN KEY (connected_by_employee_id, enterprise_id) REFERENCES enterprise_employees (id, enterprise_id)
    `);
  await run(`
      ALTER TABLE channels
        ADD CONSTRAINT channels_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT channels_connection_fk
            FOREIGN KEY (provider_connection_id, enterprise_id)
            REFERENCES provider_connections (id, enterprise_id) ON DELETE CASCADE,
        ADD CONSTRAINT channels_parent_fk
            FOREIGN KEY (parent_channel_id, enterprise_id) REFERENCES channels (id, enterprise_id)
    `);
  await run(`
      ALTER TABLE sync_jobs
        ADD CONSTRAINT sync_jobs_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT sync_jobs_channel_fk
            FOREIGN KEY (channel_id, enterprise_id) REFERENCES channels (id, enterprise_id) ON DELETE CASCADE
    `);
  await run(`
      ALTER TABLE customers
        ADD CONSTRAINT customers_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT customers_first_channel_fk
            FOREIGN KEY (first_channel_id, enterprise_id) REFERENCES channels (id, enterprise_id),
        ADD CONSTRAINT customers_last_channel_fk
            FOREIGN KEY (last_channel_id, enterprise_id) REFERENCES channels (id, enterprise_id),
        ADD CONSTRAINT customers_blocked_by_fk
            FOREIGN KEY (blocked_by_employee_id, enterprise_id) REFERENCES enterprise_employees (id, enterprise_id),
        ADD CONSTRAINT customers_merged_into_fk
            FOREIGN KEY (merged_into_customer_id, enterprise_id) REFERENCES customers (id, enterprise_id)
    `);
  await run(`
      ALTER TABLE customer_identifiers
        ADD CONSTRAINT customer_identifiers_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT customer_identifiers_customer_fk
            FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id)
    `);
  await run(`
      ALTER TABLE customer_engagements
        ADD CONSTRAINT customer_engagements_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT customer_engagements_customer_fk
            FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id),
        ADD CONSTRAINT customer_engagements_channel_fk
            FOREIGN KEY (channel_id, enterprise_id) REFERENCES channels (id, enterprise_id),
        ADD CONSTRAINT customer_engagements_last_conversation_fk
            FOREIGN KEY (last_conversation_id, enterprise_id) REFERENCES conversations (id, enterprise_id)
    `);
  await run(`
      ALTER TABLE posts
        ADD CONSTRAINT posts_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT posts_channel_fk
            FOREIGN KEY (channel_id, enterprise_id) REFERENCES channels (id, enterprise_id) ON DELETE CASCADE,
        ADD CONSTRAINT posts_authored_by_fk
            FOREIGN KEY (authored_by_employee_id, enterprise_id) REFERENCES enterprise_employees (id, enterprise_id)
    `);
  await run(`
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
            FOREIGN KEY (assigned_to_employee_id, enterprise_id) REFERENCES enterprise_employees (id, enterprise_id)
    `);
  await run(`
      ALTER TABLE messages
        ADD CONSTRAINT messages_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT messages_conversation_fk
            FOREIGN KEY (conversation_id, enterprise_id)
            REFERENCES conversations (id, enterprise_id) ON DELETE CASCADE,
        ADD CONSTRAINT messages_customer_fk
            FOREIGN KEY (customer_id, enterprise_id) REFERENCES customers (id, enterprise_id),
        ADD CONSTRAINT messages_sent_by_fk
            FOREIGN KEY (sent_by_employee_id, enterprise_id) REFERENCES enterprise_employees (id, enterprise_id),
        ADD CONSTRAINT messages_parent_fk FOREIGN KEY (parent_message_id) REFERENCES messages (id),
        ADD CONSTRAINT messages_inbound_event_fk FOREIGN KEY (inbound_event_id) REFERENCES inbound_events (id),
        ADD CONSTRAINT messages_outbound_event_fk FOREIGN KEY (outbound_event_id) REFERENCES outbound_events (id)
    `);
  await run(`
      ALTER TABLE message_attachments
        ADD CONSTRAINT message_attachments_message_fk
            FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
        ADD CONSTRAINT message_attachments_enterprise_fk
            FOREIGN KEY (enterprise_id) REFERENCES enterprises (id)
    `);
  await run(`
      ALTER TABLE inbound_events
        ADD CONSTRAINT inbound_events_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT inbound_events_channel_fk
            FOREIGN KEY (channel_id, enterprise_id) REFERENCES channels (id, enterprise_id)
    `);
  await run(`
      ALTER TABLE outbound_events
        ADD CONSTRAINT outbound_events_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT outbound_events_channel_fk
            FOREIGN KEY (channel_id, enterprise_id) REFERENCES channels (id, enterprise_id),
        ADD CONSTRAINT outbound_events_in_reply_to_fk
            FOREIGN KEY (in_reply_to_event_id) REFERENCES inbound_events (id)
    `);
  // A customer subject is tenant-scoped and its references cannot cross
  // enterprises; an identity subject is global, so enterprise_id is context only.
  await run(`
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
  await run(`
      ALTER TABLE audit_logs
        ADD CONSTRAINT audit_logs_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprises (id),
        ADD CONSTRAINT audit_logs_actor_identity_fk FOREIGN KEY (actor_identity_id) REFERENCES identities (id),
        ADD CONSTRAINT audit_logs_actor_employee_fk FOREIGN KEY (actor_employee_id) REFERENCES enterprise_employees (id),
        ADD CONSTRAINT audit_logs_actor_staff_fk FOREIGN KEY (actor_staff_id) REFERENCES staff_members (id)
    `);

  // =======================================================================
  // 5. Supporting indexes — the query paths schema.md names
  // =======================================================================

  // --- lookups right after password verification -------------------------
  await run(
    `CREATE INDEX enterprise_employees_identity_idx ON enterprise_employees (identity_id) WHERE is_deleted = false`,
  );
  await run(
    `CREATE INDEX enterprise_employees_enterprise_idx ON enterprise_employees (enterprise_id) WHERE is_deleted = false`,
  );
  await run(`CREATE INDEX enterprises_status_idx ON enterprises (status) WHERE is_deleted = false`);

  // --- permission resolution --------------------------------------------
  await run(
    `CREATE INDEX role_permissions_role_idx ON role_permissions (role_id) WHERE is_deleted = false`,
  );
  await run(
    `CREATE INDEX employee_roles_employee_idx ON employee_roles (employee_id) WHERE is_deleted = false`,
  );
  await run(`CREATE INDEX permissions_feature_idx ON permissions (feature_id)`);
  await run(`CREATE INDEX permissions_resource_idx ON permissions (resource)`);

  // --- the feature expiry sweep -----------------------------------------
  await run(`
      CREATE INDEX enterprise_features_expiry_idx ON enterprise_features (expires_at)
      WHERE is_deleted = false AND expires_at IS NOT NULL AND status = 'active'
    `);

  // --- sessions cleanup --------------------------------------------------
  await run(`CREATE INDEX sessions_identity_idx ON sessions (identity_id)`);
  await run(`CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL`);

  /*
   * The nonce is the single-use key, so its uniqueness is the guarantee rather
   * than a convention the service is trusted to keep.
   */
  await run(
    `CREATE UNIQUE INDEX oauth_states_nonce_uniq ON oauth_states (nonce) WHERE is_deleted = false`,
  );
  /* For the retention sweep, the only thing that reads these by age. */
  await run(`CREATE INDEX oauth_states_expiry_idx ON oauth_states (expires_at)`);

  // --- verifications: rate limiting and cleanup --------------------------
  await run(
    `CREATE INDEX verifications_destination_idx ON verifications (destination, created_at DESC)`,
  );
  await run(`
      CREATE INDEX verifications_expiry_idx ON verifications (expires_at)
      WHERE consumed_at IS NULL AND is_deleted = false
    `);
  await run(`CREATE INDEX verifications_identity_idx ON verifications (identity_id)`);
  await run(
    `CREATE INDEX verifications_customer_idx ON verifications (enterprise_id, customer_id)`,
  );

  // --- token expiry sweeps ----------------------------------------------
  await run(`
      CREATE INDEX provider_connections_token_expiry_idx ON provider_connections (token_expires_at)
      WHERE is_deleted = false AND token_expires_at IS NOT NULL AND status = 'active'
    `);
  await run(
    `CREATE INDEX provider_connections_enterprise_idx ON provider_connections (enterprise_id) WHERE is_deleted = false`,
  );
  await run(`
      CREATE INDEX channels_token_expiry_idx ON channels (token_expires_at)
      WHERE is_deleted = false AND token_expires_at IS NOT NULL AND status = 'active'
    `);
  await run(
    `CREATE INDEX channels_enterprise_idx ON channels (enterprise_id) WHERE is_deleted = false`,
  );
  await run(`CREATE INDEX channels_connection_idx ON channels (provider_connection_id)`);
  await run(
    `CREATE INDEX channels_parent_idx ON channels (parent_channel_id) WHERE parent_channel_id IS NOT NULL`,
  );

  // --- sync jobs: runnable work and lease reclaim ------------------------
  // COALESCE so a rate-limited job whose backoff has passed is FOUND; without
  // it there is no index that surfaces it and resuming needs a scan.
  await run(`
      CREATE INDEX sync_jobs_runnable_idx
      ON sync_jobs (COALESCE(next_attempt_at, rate_limited_until, created_at), id)
      WHERE status IN ('pending','failed','rate_limited')
    `);
  await run(
    `CREATE INDEX sync_jobs_expired_lease_idx ON sync_jobs (lease_expires_at) WHERE status = 'running'`,
  );
  await run(`CREATE INDEX sync_jobs_channel_idx ON sync_jobs (channel_id)`);

  // --- the customer directory and search --------------------------------
  await run(`
      CREATE INDEX customers_directory_idx
      ON customers (enterprise_id, last_seen_at DESC NULLS LAST, id DESC)
      WHERE is_deleted = false
    `);
  // Trigram on display_name alone: BIGINT has no GIN operator class, so a
  // composite (enterprise_id, display_name) GIN index would additionally need
  // btree_gin. The tenant filter combines as a bitmap AND instead.
  await run(
    `CREATE INDEX customers_name_trgm_idx ON customers USING gin (display_name gin_trgm_ops)`,
  );

  // --- customer identifiers ---------------------------------------------
  await run(`
      CREATE INDEX customer_identifiers_customer_idx
      ON customer_identifiers (enterprise_id, customer_id) WHERE is_deleted = false
    `);
  // Agents search a phone the way it is written locally ("9876543210", no
  // country). Only possible because national_number is a physical column — a
  // suffix match on the E.164 string would be unindexable.
  await run(`
      CREATE INDEX customer_identifiers_national_idx
      ON customer_identifiers (enterprise_id, national_number)
      WHERE national_number IS NOT NULL AND status = 'active' AND is_deleted = false
    `);

  // --- engagement segments ----------------------------------------------
  await run(`
      CREATE INDEX customer_engagements_platform_idx
      ON customer_engagements (enterprise_id, platform, last_engaged_at DESC) WHERE is_deleted = false
    `);
  await run(`
      CREATE INDEX customer_engagements_channel_idx
      ON customer_engagements (enterprise_id, channel_id, last_engaged_at DESC) WHERE is_deleted = false
    `);

  // --- the posts feed ---------------------------------------------------
  await run(`
      CREATE INDEX posts_feed_idx ON posts (enterprise_id, channel_id, published_at DESC, id)
      WHERE is_deleted = false
    `);
  // The unfiltered feed, in the order it is actually requested. See
  // conversations_inbox_order_idx for why the existing one cannot serve it.
  await run(`
      CREATE INDEX posts_feed_order_idx
      ON posts (enterprise_id, published_at DESC NULLS LAST, id DESC)
      WHERE is_deleted = false
    `);

  // --- the inbox --------------------------------------------------------
  await run(`
      CREATE INDEX conversations_inbox_idx
      ON conversations (enterprise_id, status, last_message_at DESC, id) WHERE is_deleted = false
    `);
  /*
   * THE SORT ORDER, SPELLED THE WAY THE QUERY ASKS FOR IT.
   *
   * conversations_inbox_idx cannot serve the unfiltered list: `status` sits in
   * the middle, and a gap there breaks the ordering the remaining columns would
   * otherwise give. Its directions disagree too — a DESC index column is NULLS
   * FIRST in Postgres while the query says NULLS LAST, and its `id` is ASC where
   * the query wants DESC. So every page of the inbox sorted the whole tenant.
   *
   * Kept ALONGSIDE rather than replacing it, because the status-filtered list and
   * the assignee index still want their own leading columns. That is two more
   * indexes to maintain on write, which is the trade: a conversation is written
   * a handful of times and listed on every page load.
   */
  await run(`
      CREATE INDEX conversations_inbox_order_idx
      ON conversations (enterprise_id, last_message_at DESC NULLS LAST, id DESC)
      WHERE is_deleted = false
    `);
  await run(`
      CREATE INDEX conversations_assignee_idx
      ON conversations (assigned_to_employee_id, status, last_message_at DESC) WHERE is_deleted = false
    `);
  await run(`
      CREATE INDEX conversations_post_idx ON conversations (post_id, last_message_at DESC)
      WHERE is_deleted = false
    `);
  await run(`
      CREATE INDEX conversations_customer_idx
      ON conversations (enterprise_id, customer_id, last_message_at DESC) WHERE is_deleted = false
    `);

  // --- reading a thread, and the delivery write-back --------------------
  // COALESCE: internal notes and still-queued sends have no platform
  // timestamp and must interleave by creation time, not sink to the end.
  await run(`
      CREATE INDEX messages_thread_idx
      ON messages (conversation_id, COALESCE(platform_sent_at, created_at), id) WHERE is_deleted = false
    `);
  await run(`CREATE INDEX messages_outbound_event_idx ON messages (outbound_event_id)`);
  await run(`CREATE INDEX messages_inbound_event_idx ON messages (inbound_event_id)`);
  await run(`
      CREATE INDEX messages_unread_idx ON messages (enterprise_id, conversation_id)
      WHERE is_deleted = false AND direction = 'inbound' AND is_read = false
    `);
  await run(`CREATE INDEX messages_customer_idx ON messages (enterprise_id, customer_id)`);
  await run(
    `CREATE INDEX messages_parent_idx ON messages (parent_message_id) WHERE parent_message_id IS NOT NULL`,
  );

  // --- attachments: the download worker ---------------------------------
  await run(`CREATE INDEX message_attachments_message_idx ON message_attachments (message_id)`);
  await run(`
      CREATE INDEX message_attachments_pending_idx ON message_attachments (id)
      WHERE is_downloaded = false AND status = 'active' AND is_deleted = false
    `);

  // --- the ledger claim scans -------------------------------------------
  // Ordered on (priority, due-time, id): priority is numeric so smaller runs
  // sooner, and COALESCE keeps a brand-new event from sorting behind every
  // retrying row.
  await run(`
      CREATE INDEX inbound_events_claimable_idx
      ON inbound_events (priority, COALESCE(next_attempt_at, created_at), id)
      WHERE status IN ('pending','failed')
    `);
  await run(`
      CREATE INDEX inbound_events_expired_lease_idx ON inbound_events (lease_expires_at)
      WHERE status IN ('leased','processing')
    `);
  await run(
    `CREATE INDEX inbound_events_enterprise_idx ON inbound_events (enterprise_id, created_at DESC)`,
  );
  await run(`
      CREATE INDEX inbound_events_dead_letter_idx ON inbound_events (dead_lettered_at DESC)
      WHERE status = 'dead_letter'
    `);
  await run(`
      CREATE INDEX outbound_events_due_idx
      ON outbound_events (priority, COALESCE(next_attempt_at, scheduled_at, created_at), id)
      WHERE status IN ('pending','scheduled','failed')
    `);
  await run(`
      CREATE INDEX outbound_events_expired_lease_idx ON outbound_events (lease_expires_at)
      WHERE status IN ('leased','sending')
    `);
  await run(
    `CREATE INDEX outbound_events_enterprise_idx ON outbound_events (enterprise_id, created_at DESC)`,
  );
  await run(`
      CREATE INDEX outbound_events_dead_letter_idx ON outbound_events (dead_lettered_at DESC)
      WHERE status = 'dead_letter'
    `);

  // --- the audit trail --------------------------------------------------
  await run(
    `CREATE INDEX audit_logs_enterprise_idx ON audit_logs (enterprise_id, created_at DESC)`,
  );
  await run(
    `CREATE INDEX audit_logs_actor_identity_idx ON audit_logs (actor_identity_id, created_at DESC)`,
  );
  await run(`CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id)`);
  await run(`CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC)`);
  // The question a customer will eventually ask: which Wouchh staff touched
  // my data, and when.
  await run(`
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
  await run(`
      ALTER TABLE identities
        ADD CONSTRAINT identities_has_credential_chk
        CHECK (email IS NOT NULL OR mobile IS NOT NULL)
    `);

  // Exactly one subject, never both, never neither. A customer subject is
  // additionally required to be tenant-scoped.
  await run(`
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
    await run(`
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
  // DB_APP_ROLE is what sets the GUC this reads — without it, nothing here
  // happens, which is what "the control is not configured" should look like.
  // =======================================================================
  await run(`
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
