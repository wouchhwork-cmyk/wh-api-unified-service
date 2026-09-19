import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { Platform } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * One Page, one connection — per BUSINESS.
 *
 * `channels_platform_uniq` keys a Page by CONNECTION, so a business that
 * reconnected through a different Facebook login got a second channel row for
 * the same Page. Nothing was duplicated — the inbound dedup key is scoped by
 * enterprise and catches the second copy — but the webhook fan-out attaches
 * events to whichever channel is older, so every event kept landing on the old
 * channel whose token was dead, which is the reason they reconnected. The new
 * connection sat unused and the inbox stayed broken with nothing to explain it.
 *
 * Two things are under test and the second matters as much as the first: the
 * rule holds INSIDE one business, and does not hold ACROSS businesses. An
 * agency and the brand it manages genuinely both connect the same Page.
 */
describe('one Page, one connection, per business', () => {
  let db: DataSource;
  let channels: ChannelRepository;

  const PAGE = 'PAGE_42';

  beforeAll(async () => {
    db = await createTestDataSource();
    channels = new ChannelRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await truncateTenantData(db);
  });

  async function connectionFor(enterpriseId: number, providerUserId: string): Promise<number> {
    const rows: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social',$2,'envelope') RETURNING id`,
      [enterpriseId, providerUserId],
    );
    return Number(rows[0]?.id);
  }

  const addChannel = (
    enterpriseId: number,
    connectionId: number,
    platformChannelId = PAGE,
  ): Promise<{ id: number; refId: string }> =>
    channels.upsert({
      enterpriseId,
      providerConnectionId: connectionId,
      parentChannelId: null,
      platform: Platform.Facebook,
      channelKind: 'page' as never,
      platformChannelId,
      name: 'Blue Bottle',
      username: null,
      accessToken: null,
      tokenStatus: 'not_applicable' as never,
      metadata: {},
      status: 'active' as never,
    });

  describe('the query the connect flow asks', () => {
    it('reports a Page held by a different connection in the same business', async () => {
      const enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
      const original = await connectionFor(enterpriseId, 'fb-user-one');
      await addChannel(enterpriseId, original);
      const reconnecting = await connectionFor(enterpriseId, 'fb-user-two');

      const claimed = await channels.findClaimedByAnotherConnection(enterpriseId, reconnecting, [
        PAGE,
      ]);

      expect(claimed).toEqual([{ platformChannelId: PAGE, name: 'Blue Bottle' }]);
    });

    it('says nothing when the SAME account reconnects', async () => {
      // The ordinary case, and it must stay silent: same provider_user_id means
      // the same connection row, so the upsert simply refreshes the token.
      const enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
      const connection = await connectionFor(enterpriseId, 'fb-user-one');
      await addChannel(enterpriseId, connection);

      expect(
        await channels.findClaimedByAnotherConnection(enterpriseId, connection, [PAGE]),
      ).toEqual([]);
    });

    it('does not see another business holding the same Page', async () => {
      // The agency case. Looking across the tenant boundary here would refuse a
      // connection because somebody ELSE had connected the Page.
      const agency = await seedEnterprise(db, 'Agency', 'agency');
      const brand = await seedEnterprise(db, 'Brand', 'brand');
      await addChannel(agency, await connectionFor(agency, 'fb-agency'));
      const brandConnection = await connectionFor(brand, 'fb-brand');

      expect(
        await channels.findClaimedByAnotherConnection(brand, brandConnection, [PAGE]),
      ).toEqual([]);
    });

    it('asks nothing of the database when there is nothing to ask', async () => {
      const enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
      const connection = await connectionFor(enterpriseId, 'fb-user-one');

      // `= ANY('{}')` matches nothing anyway; returning early keeps a pointless
      // round trip off the connect path.
      expect(await channels.findClaimedByAnotherConnection(enterpriseId, connection, [])).toEqual(
        [],
      );
    });
  });

  describe('the database backstop', () => {
    it('refuses a second channel for the same Page in one business', async () => {
      // The service refuses this first. This is the guard for a path that
      // forgets to ask.
      const enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
      await addChannel(enterpriseId, await connectionFor(enterpriseId, 'fb-user-one'));
      const second = await connectionFor(enterpriseId, 'fb-user-two');

      await expect(addChannel(enterpriseId, second)).rejects.toThrow();
    });

    it('still lets two businesses connect the same Page', async () => {
      /*
       * THE REGRESSION THIS COULD HAVE CAUSED. A global unique index would read
       * as correct and quietly make the agency case impossible — and it would
       * fail for the SECOND business to connect, which is whoever happens to be
       * later, with an error naming a Page they can see nothing wrong with.
       */
      const agency = await seedEnterprise(db, 'Agency', 'agency');
      const brand = await seedEnterprise(db, 'Brand', 'brand');

      await addChannel(agency, await connectionFor(agency, 'fb-agency'));

      await expect(
        addChannel(brand, await connectionFor(brand, 'fb-brand')),
      ).resolves.toBeDefined();
    });

    it('releases the Page once the channel is soft-deleted', async () => {
      /*
       * What makes the planned disconnect endpoint possible. The index is
       * partial on `is_deleted = false` — unlike the external-identity keys,
       * which deliberately collide even against deleted rows — because a
       * business that removes a connection has to be able to connect that Page
       * again. Without this, disconnecting would make the Page permanently
       * unconnectable.
       */
      const enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
      const original = await connectionFor(enterpriseId, 'fb-user-one');
      const channel = await addChannel(enterpriseId, original);
      await db.query(`UPDATE channels SET is_deleted = true WHERE id = $1`, [channel.id]);

      const replacement = await connectionFor(enterpriseId, 'fb-user-two');

      await expect(addChannel(enterpriseId, replacement)).resolves.toBeDefined();
    });

    it('does not confuse two different Pages', async () => {
      const enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
      const connection = await connectionFor(enterpriseId, 'fb-user-one');

      await addChannel(enterpriseId, connection, 'PAGE_A');

      await expect(addChannel(enterpriseId, connection, 'PAGE_B')).resolves.toBeDefined();
    });
  });
});
