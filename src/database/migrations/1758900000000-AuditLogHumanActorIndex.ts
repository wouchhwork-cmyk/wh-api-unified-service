import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keeps "what did a person do" cheap now that the system writes here too.
 *
 * Reward grants and reversals are actions the platform takes by itself, and
 * they are now recorded — correctly, with `actor_kind = 'system'`, because no
 * human is in the call stack when a webhook arrives and a rule matches.
 *
 * That volume was once the argument for not recording them at all: millions of
 * rows saying `system` drowning the handful that name a person. The premise is
 * right and the conclusion was wrong. "Why does this customer have 340 points"
 * is a question the trail has to answer whether or not a human was involved,
 * and the drowning is an indexing problem rather than a reason to keep no
 * record.
 *
 * PARTIAL on the human rows, so a staff-activity review scans only those. The
 * predicate must be written exactly as the planner sees it for the index to be
 * used, which is why it is a literal rather than a parameter.
 *
 * CONCURRENTLY is deliberately NOT used: TypeORM runs each migration inside a
 * transaction and `CREATE INDEX CONCURRENTLY` cannot run in one. The table is
 * small today — this is the moment to build it, before the system rows arrive.
 */
export class AuditLogHumanActorIndex1758900000000 implements MigrationInterface {
  name = 'AuditLogHumanActorIndex1758900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS audit_logs_human_idx
      ON audit_logs (enterprise_id, created_at DESC) WHERE actor_kind <> 'system'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS audit_logs_human_idx`);
  }
}
