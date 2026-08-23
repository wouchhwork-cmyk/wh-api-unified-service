import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import { MAX_SEND_ATTEMPTS } from '@/shared/constants';
import { DestinationKind, OutboundEventStatus, OutboundEventType, Platform } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The settlement guards on the outbound ledger.
 *
 * These exist because of a duplicate-send defect that no unit test could have
 * caught: the relay wrapped its settlement writes in the same try as the Graph
 * call, so a database error AFTER a successful send was reported as a send
 * failure, and markFailed — whose only predicate was `WHERE id = $1` — flipped
 * an already-'sent' row back to 'failed'. The relay then re-claimed it and
 * delivered the customer the same reply a second time, overwriting
 * platform_event_id so nothing in the data showed it had happened.
 *
 * The guards are in SQL, so they are tested against real Postgres.
 */
describe('outbound settlement guards', () => {
  let db: DataSource;
  let outbound: OutboundEventRepository;
  let enterpriseId: number;
  let channelId: number;

  const OWNER = 'relay-1';
  const OTHER_OWNER = 'relay-2';

  beforeAll(async () => {
    db = await createTestDataSource();
    outbound = new OutboundEventRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');

    const connection: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social','fbu','envelope') RETURNING id`,
      [enterpriseId],
    );
    const channel: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
       VALUES ($1,$2,'facebook','page','PAGE_1') RETURNING id`,
      [connection[0]?.id, enterpriseId],
    );
    channelId = Number(channel[0]?.id);
  });

  const enqueue = async (dedupKey: string): Promise<number> => {
    const { id } = await outbound.enqueue({
      enterpriseId,
      channelId,
      destinationKind: DestinationKind.Channel,
      destinationId: String(channelId),
      platform: Platform.Facebook,
      eventType: OutboundEventType.DirectMessage,
      inReplyToEventId: null,
      recipientPlatformId: 'PSID_1',
      dedupKey,
      correlationId: null,
      payload: { message: 'hello' },
      scheduledAt: null,
    });
    expect(id).not.toBeNull();
    return id as number;
  };

  const statusOf = async (id: number): Promise<string> => {
    const rows: { status: string }[] = await db.query(
      `SELECT status FROM outbound_events WHERE id = $1`,
      [id],
    );
    return rows[0]?.status ?? 'missing';
  };

  it('states the attempt budget rather than inheriting the column default', async () => {
    // MAX_SEND_ATTEMPTS was dead config: the column default of 3 was the real
    // policy, so the constant the service documents had no effect at all.
    const id = await enqueue('dedup-budget');
    const rows: { max_attempts: number }[] = await db.query(
      `SELECT max_attempts FROM outbound_events WHERE id = $1`,
      [id],
    );
    expect(Number(rows[0]?.max_attempts)).toBe(MAX_SEND_ATTEMPTS);
  });

  it('records a failure while the worker still holds the lease', async () => {
    const id = await enqueue('dedup-fail');
    await outbound.claimDueBatch(OWNER, 10, 120);

    const applied = await outbound.markFailed(id, OWNER, 'boom', new Date(Date.now() + 60_000));

    expect(applied).toBe(true);
    expect(await statusOf(id)).toBe(OutboundEventStatus.Failed);
  });

  it('REFUSES to fail a row that is already sent', async () => {
    // The duplicate-send defect, reproduced: the send succeeded, markSent
    // committed, and then a database error arrived. Before the guard this call
    // re-queued a delivered reply.
    const id = await enqueue('dedup-sent');
    await outbound.claimDueBatch(OWNER, 10, 120);
    expect(await outbound.markSent(id, OWNER, 'mid_1')).toBe(true);

    const settled = await db.query<{ platform_event_id: string; next_attempt_at: Date }[]>(
      `SELECT platform_event_id, next_attempt_at FROM outbound_events WHERE id = $1`,
      [id],
    );

    const applied = await outbound.markFailed(
      id,
      OWNER,
      'pool reset after the send',
      new Date(Date.now() + 60_000),
    );

    expect(applied).toBe(false);
    expect(await statusOf(id)).toBe(OutboundEventStatus.Sent);

    const after = await db.query<{ platform_event_id: string; next_attempt_at: Date }[]>(
      `SELECT platform_event_id, next_attempt_at FROM outbound_events WHERE id = $1`,
      [id],
    );
    /*
     * Nothing moved. The old statement rewrote both: platform_event_id was
     * cleared, which is what made the duplicate invisible in the data
     * afterwards, and next_attempt_at was set to a fresh retry time, which is
     * what actually sent the customer the second copy.
     */
    expect(after[0]?.platform_event_id).toBe('mid_1');
    expect(after[0]?.next_attempt_at).toStrictEqual(settled[0]?.next_attempt_at);
  });

  it('refuses to fail a row whose lease has moved to another worker', async () => {
    const id = await enqueue('dedup-lease');
    await outbound.claimDueBatch(OWNER, 10, 120);
    await db.query(`UPDATE outbound_events SET lease_owner = $2 WHERE id = $1`, [id, OTHER_OWNER]);

    const applied = await outbound.markFailed(id, OWNER, 'stale worker', new Date());

    expect(applied).toBe(false);
    const rows: { lease_owner: string | null }[] = await db.query(
      `SELECT lease_owner FROM outbound_events WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.lease_owner).toBe(OTHER_OWNER);
  });

  it('refuses to cancel a row that is already sent', async () => {
    const id = await enqueue('dedup-cancel-sent');
    await outbound.claimDueBatch(OWNER, 10, 120);
    await outbound.markSent(id, OWNER, 'mid_2');

    expect(await outbound.cancel(id, OWNER, 'stale decision')).toBe(false);
    expect(await statusOf(id)).toBe(OutboundEventStatus.Sent);
  });

  it('cancels a leased row and reports that it did', async () => {
    const id = await enqueue('dedup-cancel');
    await outbound.claimDueBatch(OWNER, 10, 120);

    expect(await outbound.cancel(id, OWNER, 'no usable token')).toBe(true);
    expect(await statusOf(id)).toBe(OutboundEventStatus.Cancelled);
  });

  it('dead-letters once the budget is spent', async () => {
    const id = await enqueue('dedup-dead');
    await outbound.claimDueBatch(OWNER, 10, 120);
    await db.query(`UPDATE outbound_events SET attempt_count = max_attempts WHERE id = $1`, [id]);

    expect(await outbound.markFailed(id, OWNER, 'spent', null)).toBe(true);
    expect(await statusOf(id)).toBe(OutboundEventStatus.DeadLetter);

    const rows: { dead_lettered_at: Date | null }[] = await db.query(
      `SELECT dead_lettered_at FROM outbound_events WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.dead_lettered_at).not.toBeNull();
  });
});
