import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The two assistant switches, against real Postgres.
 *
 * WRITTEN BECAUSE THE MOCKED TESTS PASSED AND THE FEATURE DID NOT. Every
 * test covering this went through a stubbed repository, so the SQL itself
 * was never executed once — and it was wrong. Live, the assistant handed
 * over, the write threw "column needs_human_message_id is of type bigint
 * but expression is of type text", the error was swallowed by design
 * (correctly: the customer had already been answered), and the flag simply
 * never appeared. Nothing failed loudly.
 *
 * The cause was Postgres type inference: a parameter inside a CASE whose
 * arms are that parameter and NULL has nothing to be inferred from, so it
 * defaults to text. Only a real database can catch that, which is why these
 * are here rather than beside the service tests.
 */
describe('the assistant switches, per channel', () => {
  let db: DataSource;
  let customers: CustomerRepository;

  let enterpriseId: number;
  let customerId: number;
  let channelA: number;
  let channelB: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    customers = new CustomerRepository(db);
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
    /* TWO ACCOUNTS ON ONE PLATFORM, which is the case the grain exists for. */
    const channels: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
       VALUES ($1,$2,'instagram','page','PAGE_A'), ($1,$2,'instagram','page','PAGE_B')
       RETURNING id`,
      [connection[0]?.id, enterpriseId],
    );
    channelA = Number(channels[0]?.id);
    channelB = Number(channels[1]?.id);

    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source)
       VALUES ($1,'Aditya','direct_message') RETURNING id`,
      [enterpriseId],
    );
    customerId = Number(customer[0]?.id);
  });

  describe('raising that somebody needs a person', () => {
    it('writes a row where there was none', async () => {
      await customers.setNeedsHuman({
        enterpriseId,
        customerId,
        channelId: channelA,
        needsHuman: true,
        reason: 'wants a refund decision',
        messageId: 4242,
      });

      const state = await customers.assistantState(enterpriseId, customerId, channelA);
      expect(state.needsHuman).toBe(true);
      expect(state.needsHumanReason).toBe('wants a refund decision');
    });

    it('stores the message that raised it as a number, not as text', async () => {
      /*
       * THE EXACT FAILURE. A parameter inside a CASE with a NULL arm is
       * inferred as text, and this column is a bigint — so the whole insert
       * threw and the flag never appeared.
       */
      await customers.setNeedsHuman({
        enterpriseId,
        customerId,
        channelId: channelA,
        needsHuman: true,
        messageId: 4242,
      });

      const rows: { needs_human_message_id: string }[] = await db.query(
        `SELECT needs_human_message_id FROM customer_assistant_states
          WHERE customer_id = $1 AND channel_id = $2`,
        [customerId, channelA],
      );
      expect(Number(rows[0]?.needs_human_message_id)).toBe(4242);
    });

    it('does not move the clock when it is raised again', async () => {
      // How long they have waited is the only urgency there is. Re-raising
      // on every message would make the longest wait read as the newest.
      await customers.setNeedsHuman({
        enterpriseId,
        customerId,
        channelId: channelA,
        needsHuman: true,
        reason: 'first',
      });
      const first = await customers.assistantState(enterpriseId, customerId, channelA);

      await customers.setNeedsHuman({
        enterpriseId,
        customerId,
        channelId: channelA,
        needsHuman: true,
        reason: 'second',
      });
      const again = await customers.assistantState(enterpriseId, customerId, channelA);

      expect(again.needsHumanSince?.toISOString()).toBe(first.needsHumanSince?.toISOString());
    });

    it('clears everything about it when a colleague marks it handled', async () => {
      await customers.setNeedsHuman({
        enterpriseId,
        customerId,
        channelId: channelA,
        needsHuman: true,
        reason: 'wants a refund',
      });
      await customers.setNeedsHuman({
        enterpriseId,
        customerId,
        channelId: channelA,
        needsHuman: false,
      });

      const state = await customers.assistantState(enterpriseId, customerId, channelA);
      expect(state).toMatchObject({
        needsHuman: false,
        needsHumanReason: null,
        needsHumanSince: null,
      });
    });

    it('stays on the account it was raised on', async () => {
      /*
       * THE WHOLE POINT OF THE GRAIN. One business can run two Instagram
       * accounts, and a flag raised in one inbox must not appear in the
       * other's.
       */
      await customers.setNeedsHuman({
        enterpriseId,
        customerId,
        channelId: channelA,
        needsHuman: true,
        reason: 'only here',
      });

      expect((await customers.assistantState(enterpriseId, customerId, channelB)).needsHuman).toBe(
        false,
      );
    });
  });

  describe('pausing the assistant', () => {
    it('reads back as paused', async () => {
      await customers.setAutomationPause({
        enterpriseId,
        customerId,
        channelId: channelA,
        paused: true,
        byEmployeeId: 7,
      });

      expect((await customers.assistantState(enterpriseId, customerId, channelA)).paused).toBe(
        true,
      );
    });

    it('comes back by itself once the resume time has passed', async () => {
      // A pause nobody remembers to lift is an assistant silently off, which
      // looks exactly like one that is broken. "Paused" is two columns and
      // the clock, and the clock is read in SQL rather than by a caller.
      await customers.setAutomationPause({
        enterpriseId,
        customerId,
        channelId: channelA,
        paused: true,
        resumesAt: new Date(Date.now() - 1000),
      });

      expect((await customers.assistantState(enterpriseId, customerId, channelA)).paused).toBe(
        false,
      );
    });

    it('keeps the time it actually started when paused twice', async () => {
      await customers.setAutomationPause({
        enterpriseId,
        customerId,
        channelId: channelA,
        paused: true,
      });
      const rows = async (): Promise<{ automation_paused_at: Date }[]> =>
        db.query(
          `SELECT automation_paused_at FROM customer_assistant_states
            WHERE customer_id = $1 AND channel_id = $2`,
          [customerId, channelA],
        );
      const first = (await rows())[0]?.automation_paused_at;

      await customers.setAutomationPause({
        enterpriseId,
        customerId,
        channelId: channelA,
        paused: true,
      });

      expect((await rows())[0]?.automation_paused_at?.toISOString()).toBe(first?.toISOString());
    });

    it('leaves the other account talking', async () => {
      await customers.setAutomationPause({
        enterpriseId,
        customerId,
        channelId: channelA,
        paused: true,
      });

      expect((await customers.assistantState(enterpriseId, customerId, channelB)).paused).toBe(
        false,
      );
    });

    it('does not disturb a handoff raised on the same account', async () => {
      // Two switches, one row. Setting either must not clear the other.
      await customers.setNeedsHuman({
        enterpriseId,
        customerId,
        channelId: channelA,
        needsHuman: true,
        reason: 'wants a refund',
      });
      await customers.setAutomationPause({
        enterpriseId,
        customerId,
        channelId: channelA,
        paused: true,
      });

      const state = await customers.assistantState(enterpriseId, customerId, channelA);
      expect(state.needsHuman).toBe(true);
      expect(state.paused).toBe(true);
    });
  });

  it('reads the ordinary state for somebody with no row at all', async () => {
    // Rows exist only where somebody changed something, so missing is the
    // common case and must not be an error.
    expect(await customers.assistantState(enterpriseId, customerId, channelA)).toMatchObject({
      needsHuman: false,
      paused: false,
    });
  });

  it('never reads another business’s state', async () => {
    const rival = await seedEnterprise(db, 'Rival', 'rival');
    await customers.setNeedsHuman({
      enterpriseId,
      customerId,
      channelId: channelA,
      needsHuman: true,
      reason: 'acme only',
    });

    expect((await customers.assistantState(rival, customerId, channelA)).needsHuman).toBe(false);
  });
});
