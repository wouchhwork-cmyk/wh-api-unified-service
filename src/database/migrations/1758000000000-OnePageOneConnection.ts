import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One Page, one connection, per business.
 *
 * `channels_platform_uniq` is (platform, platform_channel_id,
 * provider_connection_id) — a Page is unique per CONNECTION, not per business.
 * So a business reconnecting through a different Facebook login got a second
 * channel row for the same Page, and the webhook fan-out attaches events to
 * whichever is older: every event kept landing on the old channel whose token
 * was dead, which is the reason they were reconnecting. The new connection sat
 * unused and the inbox stayed broken.
 *
 * SCOPED BY ENTERPRISE, NEVER GLOBAL. Across businesses the same Page
 * legitimately exists more than once — an agency and the brand it manages can
 * both connect it and each must process events independently. That case is
 * deliberate and this index must not break it.
 *
 * PARTIAL ON is_deleted, which the other external-identity indexes are NOT.
 * Theirs exist to make a redelivered webhook collide even against a soft-deleted
 * row. This one is a business rule, and the rule has to release the Page when a
 * connection is removed — otherwise disconnecting would leave it permanently
 * unconnectable.
 *
 * The service refuses this case with CHANNEL_ALREADY_CONNECTED before reaching
 * here. This is the backstop for a path that forgets to ask.
 *
 * EXPAND ONLY. A database that somehow already holds a duplicate will fail to
 * create this index rather than silently drop a row — which is the right
 * outcome: two channels for one Page is a question for a person, not something
 * to resolve by guessing which one to keep.
 */
export class OnePageOneConnection1758000000000 implements MigrationInterface {
  name = 'OnePageOneConnection1758000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS channels_enterprise_platform_uniq
      ON channels (enterprise_id, platform, platform_channel_id)
      WHERE is_deleted = false
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS channels_enterprise_platform_uniq`);
  }
}
