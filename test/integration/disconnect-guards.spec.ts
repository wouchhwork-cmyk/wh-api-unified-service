import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';
import { Platform } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * What a disconnect actually stops.
 *
 * The endpoint's contract has two halves and they pull in opposite directions:
 * withdraw every authority, keep every row. Marking a status is the easy half.
 * These are the queries that decide whether the mark MEANS anything — the
 * webhook fan-out, the send path and the backfill all resolve a channel before
 * they act, and any one of them forgetting the filter would leave a business
 * that asked us to let go still being acted for.
 *
 * Asserted at the repository rather than through HTTP because that is where the
 * guard lives, and because "a webhook was ignored" is otherwise an absence that
 * is easy to assert vacuously.
 */
describe('a disconnected channel acts for nobody', () => {
  let db: DataSource;
  let channels: ChannelRepository;
  let connections: ProviderConnectionRepository;

  const PAGE = 'PAGE_DISC';

  beforeAll(async () => {
    db = await createTestDataSource();
    channels = new ChannelRepository(db);
    connections = new ProviderConnectionRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await truncateTenantData(db);
  });

  async function connected(): Promise<{
    enterpriseId: number;
    connectionId: number;
    channelId: number;
  }> {
    const enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    const rows: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social','fb-user','envelope') RETURNING id`,
      [enterpriseId],
    );
    const connectionId = Number(rows[0]?.id);
    const channel = await channels.upsert({
      enterpriseId,
      providerConnectionId: connectionId,
      parentChannelId: null,
      platform: Platform.Facebook,
      channelKind: 'page' as never,
      platformChannelId: PAGE,
      name: 'Blue Bottle',
      username: null,
      accessToken: 'envelope',
      tokenStatus: 'valid' as never,
      metadata: {},
      status: 'active' as never,
    });
    return { enterpriseId, connectionId, channelId: channel.id };
  }

  it('is still resolvable while it is connected', async () => {
    // The control. Without it every assertion below could pass because the
    // fixture never worked.
    const { enterpriseId, channelId } = await connected();

    expect(await channels.findAllByPlatformId(Platform.Facebook, PAGE)).toHaveLength(1);
    expect(await channels.findSendContext(enterpriseId, channelId)).not.toBeNull();
    expect(await channels.findBackfillContext(enterpriseId, channelId)).not.toBeNull();
  });

  /*
   * NO WEBHOOK IS CONSUMED. This is the lookup that turns an incoming Page id
   * into a tenant, so returning nothing is what makes the delivery `unmatched`
   * — an already-handled path that stores nothing. Meta can keep delivering for
   * a while after we unsubscribe, and the published app relays traffic for
   * accounts that were never ours, so the local guard is what actually decides.
   */
  it('resolves no tenant for an inbound webhook once disconnected', async () => {
    const { enterpriseId, connectionId } = await connected();

    await channels.disconnectForConnection(enterpriseId, connectionId);

    expect(await channels.findAllByPlatformId(Platform.Facebook, PAGE)).toEqual([]);
  });

  /* NO INTERACTION. Neither sending nor backfilling can find it. */
  it('cannot be sent for, or backfilled, once disconnected', async () => {
    const { enterpriseId, connectionId, channelId } = await connected();

    await channels.disconnectForConnection(enterpriseId, connectionId);

    expect(await channels.findSendContext(enterpriseId, channelId)).toBeNull();
    expect(await channels.findBackfillContext(enterpriseId, channelId)).toBeNull();
  });

  /*
   * DEFENCE IN DEPTH. Status is a rule every future query has to remember; a
   * cleared token is one the data enforces whatever a query forgets.
   */
  it('keeps no usable credential', async () => {
    const { enterpriseId, connectionId } = await connected();

    await channels.disconnectForConnection(enterpriseId, connectionId);

    const rows: { access_token: string | null; token_status: string }[] = await db.query(
      `SELECT access_token, token_status FROM channels WHERE platform_channel_id = $1`,
      [PAGE],
    );
    expect(rows[0]?.access_token).toBeNull();
    expect(rows[0]?.token_status).toBe('revoked');
  });

  it('revokes the connection itself, once, and reports whether it did', async () => {
    const { enterpriseId, connectionId } = await connected();

    expect(await connections.revoke(enterpriseId, connectionId)).toBe(true);
    // Idempotent: a second disconnect is not an error, and changes nothing.
    expect(await connections.revoke(enterpriseId, connectionId)).toBe(false);
  });

  /*
   * ANOTHER TENANT'S COPY OF THE SAME PAGE IS UNAFFECTED. An agency and the
   * brand it manages can both connect one Page, and one of them letting go must
   * not silence the other — the fan-out would otherwise lose a tenant that
   * never asked for anything.
   */
  it('leaves another business holding the same Page connected', async () => {
    const mine = await connected();

    const theirs = await seedEnterprise(db, 'Other', 'other');
    const rows: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social','fb-user-2','envelope') RETURNING id`,
      [theirs],
    );
    await channels.upsert({
      enterpriseId: theirs,
      providerConnectionId: Number(rows[0]?.id),
      parentChannelId: null,
      platform: Platform.Facebook,
      channelKind: 'page' as never,
      platformChannelId: PAGE,
      name: 'Blue Bottle',
      username: null,
      accessToken: 'envelope',
      tokenStatus: 'valid' as never,
      metadata: {},
      status: 'active' as never,
    });

    await channels.disconnectForConnection(mine.enterpriseId, mine.connectionId);

    const resolved = await channels.findAllByPlatformId(Platform.Facebook, PAGE);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.enterpriseId).toBe(theirs);
  });
});
