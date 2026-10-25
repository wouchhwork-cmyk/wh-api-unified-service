import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A version history for configuration that can be edited.
 *
 * WHAT THE AUDIT LOG CANNOT DO. `audit_logs` answers "who changed this, and
 * when", and it answers it well. It does not answer "what did this look like in
 * March" — `changes` holds a diff of the fields the call site chose to name, so
 * reconstructing a past state means replaying every diff since creation and
 * hoping none of them omitted a field. For a reward program, where the
 * configuration decides who receives money, that is not good enough: an award
 * made last March was decided by the program AS IT WAS last March.
 *
 * `reward_rules` already solve this for themselves with a `version` column and
 * `supersedes_rule_id`, and an award stores the rule version that decided it.
 * This is the same idea generalised, for entities that are edited in place
 * rather than superseded.
 *
 * ONE TABLE, NOT ONE PER ENTITY. `entity_type` + `entity_id` addresses any row
 * in the schema, so adding history to roles or programs or anything else is a
 * call site rather than a migration. The cost is that `entity_id` is not a
 * foreign key — it points at whichever table `entity_type` names — which is the
 * same trade `audit_logs` already makes and for the same reason.
 *
 * THE SNAPSHOT IS PASSED IN, NEVER SERIALISED FROM THE ROW. A reward program
 * carries `forward_config`, which holds a CREDENTIAL REFERENCE. Auto-capturing
 * the row would put it in the history on the first edit, and history is
 * append-only, so it could never be taken back out. Making each call site state
 * what it stores keeps redaction a deliberate act.
 *
 * APPEND-ONLY, enforced by trigger exactly as `audit_logs` and
 * `reward_ledger_entries` are. A version history that can be edited is not a
 * history.
 */
export class EntityVersions1759000000000 implements MigrationInterface {
  name = 'EntityVersions1759000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS entity_versions (
        id                 BIGSERIAL     PRIMARY KEY,
        enterprise_id      BIGINT        NOT NULL,
        entity_type        VARCHAR(50)   NOT NULL,
        entity_id          BIGINT        NOT NULL,
        version            INTEGER       NOT NULL,
        /* The whole of what the entity was AFTER this change, redacted at the
           call site. Readable on its own: reconstructing a state must never
           require replaying every earlier row. */
        snapshot           JSONB         NOT NULL DEFAULT '{}',
        /* What moved, relative to the previous version. Convenience for a
           reader; the snapshots remain the authority. */
        change_summary     JSONB         NOT NULL DEFAULT '{}',
        /* The same three-column actor as audit_logs, for the same reason: a
           Wouchh employee editing a customer's program must be distinguishable
           from the customer's own staff doing it. */
        actor_identity_id  BIGINT,
        actor_employee_id  BIGINT,
        actor_staff_id     BIGINT,
        actor_kind         VARCHAR(30)   NOT NULL,
        is_impersonated    BOOLEAN       NOT NULL DEFAULT false,
        /* Ties a version to the request that produced it, and so to the
           audit_logs row written in the same breath. */
        correlation_id     VARCHAR(64),
        is_deleted         BOOLEAN       NOT NULL DEFAULT false,
        created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);

    /*
     * THE VERSION NUMBER IS UNIQUE PER ENTITY, and this index is what makes it
     * true rather than hoped for. The repository allocates `MAX(version) + 1`,
     * which two concurrent writers could both compute as the same number; this
     * makes the loser fail loudly instead of silently overwriting the history.
     */
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS entity_versions_uniq
      ON entity_versions (enterprise_id, entity_type, entity_id, version)
    `);

    /* The history read: newest first, for one entity. */
    await q.query(`
      CREATE INDEX IF NOT EXISTS entity_versions_history_idx
      ON entity_versions (enterprise_id, entity_type, entity_id, version DESC)
    `);

    await q.query(`
      ALTER TABLE entity_versions
        DROP CONSTRAINT IF EXISTS entity_versions_enterprise_fk,
        ADD CONSTRAINT entity_versions_enterprise_fk
            FOREIGN KEY (enterprise_id) REFERENCES enterprises (id)
    `);

    await q.query(`
      CREATE OR REPLACE FUNCTION entity_versions_is_append_only()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'entity_versions is append-only: % is not permitted. Write a new version.', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);
    await q.query(`DROP TRIGGER IF EXISTS entity_versions_append_only ON entity_versions`);
    await q.query(`
      CREATE TRIGGER entity_versions_append_only
        BEFORE UPDATE OR DELETE ON entity_versions
        FOR EACH ROW EXECUTE FUNCTION entity_versions_is_append_only()
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS entity_versions_append_only ON entity_versions`);
    await q.query(`DROP FUNCTION IF EXISTS entity_versions_is_append_only()`);
    await q.query(`DROP TABLE IF EXISTS entity_versions`);
  }
}
