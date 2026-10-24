import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes `audit_logs` append-only in the database, which it was documented as
 * being and was not.
 *
 * The entity and the repository both stated it as fact: "UPDATE and DELETE are
 * revoked from the application role". The REVOKE that would do that is guarded
 * by `wouchh.app_role` being set AND differing from the connected user, which
 * is false on every developer machine and anywhere `DB_APP_ROLE` is unset. So
 * the control was not merely weak, it was absent — while two comments asserted
 * it was in force.
 *
 * Measured on the dev database rather than assumed. The application role held
 * UPDATE, DELETE and TRUNCATE on `audit_logs`, and against a real row both of
 * these succeeded (rolled back):
 *
 *     UPDATE audit_logs SET action = 'tampered' WHERE id = (SELECT min(id) ...)
 *     DELETE FROM audit_logs WHERE id = (SELECT min(id) ...)
 *
 * That matters more here than almost anywhere else in the schema. The audit
 * trail is the only thing that distinguishes legitimate support work from an
 * insider reading a customer's inbox, and `updated_at <> created_at` is sold as
 * a tamper tripwire — but a tripwire is worthless if the ordinary application
 * role can edit the row it is attached to.
 *
 * A TRIGGER, not a REVOKE, because the trigger does not care which role is
 * connected. This is the same mechanism `reward_ledger_entries` already uses,
 * added there for the same reason and somehow not here.
 *
 * TRUNCATE IS DELIBERATELY NOT BLOCKED. A row-level trigger does not see it,
 * and the e2e harness truncates this table between cases — the same bargain the
 * ledger strikes. Blocking it would need a statement-level trigger and would
 * buy little: anyone able to TRUNCATE can drop the trigger.
 *
 * THE HONEST LIMIT: a role with DDL rights can drop this. It stops the
 * accidental UPDATE and the well-meaning repair script, which is the realistic
 * threat. It is not a defence against someone who can already reshape the
 * schema.
 */
export class AuditLogAppendOnly1758800000000 implements MigrationInterface {
  name = 'AuditLogAppendOnly1758800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE FUNCTION audit_logs_is_append_only()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only: % is not permitted.', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);

    /*
     * IDEMPOTENT, because a database built by the sync path already has this:
     * `applyPostTableObjects` creates it alongside the table. Dropping first
     * makes one statement correct for a fresh install and an existing one alike,
     * rather than needing to know which it is looking at.
     */
    await q.query(`DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs`);
    await q.query(`
      CREATE TRIGGER audit_logs_append_only
        BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION audit_logs_is_append_only()
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs`);
    await q.query(`DROP FUNCTION IF EXISTS audit_logs_is_append_only()`);
  }
}
