import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { MessageAttachmentRepository } from '@/database/repositories/message-attachment.repository';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * Replacing an expired attachment link, against real Postgres.
 *
 * WHY THIS IS CLIENT-DRIVEN. Message media lives on `lookaside.fbsbx.com` and
 * carries NO expiry in the URL — unlike a mention's media, where `oe=` says the
 * moment it dies. Measured 19 Sep 2026: of five links stored on 06 Sep, a HEAD
 * returned 200, 404, 200, 404, 200. Half dead in under a fortnight with nothing
 * to predict which half, so the browser is the only party that finds out.
 *
 * The two things worth pinning are both about NOT doing damage: this is the
 * only place an attachment row is ever mutated, and the matching rule decides
 * which link lands on which message.
 */
describe('refreshing expired attachment links', () => {
  let db: DataSource;
  let attachments: MessageAttachmentRepository;
  let enterpriseId: number;
  let conversationId: number;
  let otherEnterpriseId: number;

  const DEAD = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=old';
  const FRESH = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=new';
  const SHARE = 'https://www.instagram.com/reel/DaLQejvgjsj/';

  beforeAll(async () => {
    db = await createTestDataSource();
    attachments = new MessageAttachmentRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    otherEnterpriseId = await seedEnterprise(db, 'Rival', 'rival');
    conversationId = await seedConversation(enterpriseId, 'IG_1', 'fbu1');
  });

  async function seedConversation(
    tenant: number,
    channelKey: string,
    providerUser: string,
  ): Promise<number> {
    const connection: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social',$2,'envelope') RETURNING id`,
      [tenant, providerUser],
    );
    const channel: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
       VALUES ($1,$2,'instagram','instagram_business',$3) RETURNING id`,
      [connection[0]?.id, tenant, channelKey],
    );
    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source)
       VALUES ($1,'Someone','instagram_dm') RETURNING id`,
      [tenant],
    );
    const conversation: { id: string }[] = await db.query(
      `INSERT INTO conversations
         (enterprise_id, channel_id, customer_id, platform, conversation_kind, platform_thread_id)
       VALUES ($1,$2,$3,'instagram','direct_message',$4) RETURNING id`,
      [tenant, channel[0]?.id, customer[0]?.id, `dm:${channelKey}`],
    );
    return Number(conversation[0]?.id);
  }

  async function seedAttachment(
    tenant: number,
    conversation: number,
    platformMessageId: string,
    url: string,
    sortOrder = 0,
    metadata: Record<string, unknown> = {},
  ): Promise<number> {
    const message: { id: string }[] = await db.query(
      `INSERT INTO messages
         (enterprise_id, conversation_id, direction, message_kind, status,
          platform_message_id, has_attachments)
       VALUES ($1,$2,'inbound','image','delivered',$3,true)
       ON CONFLICT DO NOTHING RETURNING id`,
      [tenant, conversation, platformMessageId],
    );
    let messageId = message[0]?.id;
    if (!messageId) {
      const existing: { id: string }[] = await db.query(
        `SELECT id FROM messages WHERE enterprise_id = $1 AND platform_message_id = $2`,
        [tenant, platformMessageId],
      );
      messageId = existing[0]?.id;
    }
    const row: { id: string }[] = await db.query(
      `INSERT INTO message_attachments
         (enterprise_id, message_id, media_kind, source_url, sort_order, metadata)
       VALUES ($1,$2,'image',$3,$4,$5::jsonb) RETURNING id`,
      [tenant, messageId, url, sortOrder, JSON.stringify(metadata)],
    );
    return Number(row[0]?.id);
  }

  describe('choosing what is even a candidate', () => {
    it('offers an expiring CDN link', async () => {
      await seedAttachment(enterpriseId, conversationId, 'mid:1', DEAD);

      const rows = await attachments.listRefreshable(enterpriseId, conversationId);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.sourceUrl).toBe(DEAD);
    });

    it('leaves a permanent link alone', async () => {
      /*
       * A share is an instagram.com permalink and does not expire. Including it
       * would also shift the positions the matching relies on, because the
       * fresh side filters these out too.
       */
      await seedAttachment(enterpriseId, conversationId, 'mid:2', SHARE, 0, {
        stableUrl: true,
      });

      expect(await attachments.listRefreshable(enterpriseId, conversationId)).toEqual([]);
    });

    it('returns a message’s attachments in the order they were stored', async () => {
      // Position is how a fresh link is matched to a row, so the order the
      // query returns is part of the contract, not a detail.
      await seedAttachment(enterpriseId, conversationId, 'mid:3', `${DEAD}&n=2`, 1);
      await seedAttachment(enterpriseId, conversationId, 'mid:3', `${DEAD}&n=1`, 0);

      const rows = await attachments.listRefreshable(enterpriseId, conversationId);

      expect(rows.map((row) => row.sortOrder)).toEqual([0, 1]);
    });

    it('does not reach into another business', async () => {
      const rivalConversation = await seedConversation(otherEnterpriseId, 'IG_2', 'fbu2');
      await seedAttachment(otherEnterpriseId, rivalConversation, 'mid:9', DEAD);

      expect(await attachments.listRefreshable(enterpriseId, conversationId)).toEqual([]);
    });
  });

  describe('replacing the link', () => {
    it('replaces the url and nothing else', async () => {
      /*
       * The media kind, sort order and metadata describe what was SENT.
       * Re-reading the thread is not new information about any of that, and a
       * refresh that rewrote them would let a re-read silently reinterpret a
       * message somebody has already seen.
       */
      const id = await seedAttachment(enterpriseId, conversationId, 'mid:4', DEAD, 3, {
        platformType: 'image',
      });

      await attachments.refreshSourceUrls(enterpriseId, [{ id, sourceUrl: FRESH }]);

      const rows: { source_url: string; sort_order: number; media_kind: string; metadata: unknown }[] =
        await db.query(
          `SELECT source_url, sort_order, media_kind, metadata FROM message_attachments WHERE id = $1`,
          [id],
        );
      expect(rows[0]?.source_url).toBe(FRESH);
      expect(rows[0]?.sort_order).toBe(3);
      expect(rows[0]?.media_kind).toBe('image');
      expect(rows[0]?.metadata).toEqual({ platformType: 'image' });
    });

    it('updates several in one statement', async () => {
      const first = await seedAttachment(enterpriseId, conversationId, 'mid:5', `${DEAD}&a`, 0);
      const second = await seedAttachment(enterpriseId, conversationId, 'mid:5', `${DEAD}&b`, 1);

      const affected = await attachments.refreshSourceUrls(enterpriseId, [
        { id: first, sourceUrl: `${FRESH}&a` },
        { id: second, sourceUrl: `${FRESH}&b` },
      ]);

      expect(affected).toBe(2);
    });

    it('refuses to touch another business’s attachment', async () => {
      /*
       * The id alone is not authority. Without the tenant clause, an attachment
       * id from anywhere would be updatable through this path — and this is the
       * one place attachments are mutable at all.
       */
      const rivalConversation = await seedConversation(otherEnterpriseId, 'IG_3', 'fbu3');
      const rivalId = await seedAttachment(otherEnterpriseId, rivalConversation, 'mid:6', DEAD);

      const affected = await attachments.refreshSourceUrls(enterpriseId, [
        { id: rivalId, sourceUrl: FRESH },
      ]);

      expect(affected).toBe(0);
      const rows: { source_url: string }[] = await db.query(
        `SELECT source_url FROM message_attachments WHERE id = $1`,
        [rivalId],
      );
      expect(rows[0]?.source_url).toBe(DEAD);
    });

    it('does nothing when there is nothing to do', async () => {
      // The common case once a thread has been refreshed: no statement at all.
      expect(await attachments.refreshSourceUrls(enterpriseId, [])).toBe(0);
    });
  });
});
