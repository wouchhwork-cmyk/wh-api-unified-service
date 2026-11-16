import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ModelCallRepository } from '@/database/repositories/model-call.repository';
import { ModelCallPurpose, ModelCallStatus } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The record of what this service sent to a model, against real Postgres.
 *
 * The question this table exists to answer is a bill: what did this business
 * spend, on which model, on what, and how much of it failed. None of that is
 * answerable from the ledgers that asked for the work — those are updated in
 * place, so a retry overwrites the attempt before it.
 */
describe('the model call record', () => {
  let db: DataSource;
  let calls: ModelCallRepository;
  let enterpriseId: number;
  let otherEnterpriseId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    calls = new ModelCallRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    await db.query(`DELETE FROM model_calls`);
    enterpriseId = await seedEnterprise(db, 'Spend Co', 'spend-co');
    otherEnterpriseId = await seedEnterprise(db, 'Rival Co', 'rival-co');
  });

  /** One whole call: opened before it goes out, settled when it comes back. */
  const call = async (
    intent: Partial<Parameters<ModelCallRepository['begin']>[0]> = {},
    outcome: Partial<Parameters<ModelCallRepository['settle']>[1]> = {},
  ) => {
    const id = await calls.begin({
      enterpriseId,
      provider: 'openai',
      model: 'gpt-6-luna',
      purpose: ModelCallPurpose.AutoReply,
      ...intent,
    });
    await calls.settle(id, {
      status: ModelCallStatus.Ok,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      durationMs: 850,
      ...outcome,
    });
    return id;
  };

  const since = () => new Date(Date.now() - 60_000);

  it('keeps what a call cost and how long it took', async () => {
    await call();

    const [row] = await calls.spendFor(enterpriseId, since());
    expect(row).toMatchObject({
      provider: 'openai',
      model: 'gpt-6-luna',
      calls: 1,
      failed: 0,
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  /**
   * THE ONE THE LEDGERS CANNOT ANSWER. An owed reply is one row updated in
   * place, so three attempts leave one set of numbers — and the tokens the
   * first two spent are simply gone.
   */
  it('keeps every attempt, not just the one that worked', async () => {
    const failed = {
      status: ModelCallStatus.Failed as const,
      failureCode: 'CHAT_TIMEOUT',
      outputTokens: 0,
    };
    await call({}, failed);
    await call({}, failed);
    await call();

    const [row] = await calls.spendFor(enterpriseId, since());
    expect(row).toMatchObject({ calls: 3, failed: 2, inputTokens: 300 });
  });

  it('tells a draft somebody asked for apart from one the platform sent', async () => {
    await call({ purpose: ModelCallPurpose.Draft });
    await call({ purpose: ModelCallPurpose.AutoReply });

    const rows = await calls.spendFor(enterpriseId, since());
    expect(rows.map((row) => row.purpose).sort()).toEqual(['auto_reply', 'draft']);
  });

  it('groups a media description under its own purpose and key', async () => {
    await call({
      purpose: ModelCallPurpose.MediaDescription,
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      mediaKey: 'asset:9',
    });

    const [row] = await calls.spendFor(enterpriseId, since());
    expect(row).toMatchObject({
      provider: 'gemini',
      purpose: ModelCallPurpose.MediaDescription,
    });
  });

  it('never shows one business what another spent', async () => {
    await call();
    expect(await calls.spendFor(otherEnterpriseId, since())).toEqual([]);
  });

  it('leaves older calls out of the window', async () => {
    await call();
    expect(await calls.spendFor(enterpriseId, new Date(Date.now() + 60_000))).toEqual([]);
  });

  /**
   * It runs after a call that already happened, often one that already
   * failed. A bookkeeping write that took the customer's reply down with it
   * would be the worse bug by a wide margin.
   */
  it('swallows a failure to SETTLE rather than failing the call it describes', async () => {
    /*
     * By then the call has already happened. A bookkeeping failure that took
     * the customer's reply with it would be the worse bug by a wide margin,
     * and the row is not lost — it stays in flight for the sweep.
     */
    const id = await calls.begin({
      enterpriseId,
      provider: 'openai',
      model: 'gpt-6-luna',
      purpose: ModelCallPurpose.AutoReply,
    });

    await expect(
      /* Longer than the column, so the update is refused by Postgres. */
      calls.settle(id, { status: ModelCallStatus.Ok }, 'm'.repeat(200)),
    ).resolves.toBeUndefined();

    expect(await inFlight()).toBe(1);
  });

  /**
   * THE WHOLE POINT OF WRITING IT FIRST. A process that dies between the
   * model answering and the settle landing used to leave nothing at all:
   * a call made, very likely billed, with no trace.
   */
  describe('a call whose process never came back', () => {
    it('leaves a row saying one went out', async () => {
      await calls.begin({
        enterpriseId,
        provider: 'openai',
        model: 'gpt-6-luna',
        purpose: ModelCallPurpose.AutoReply,
      });

      expect(await inFlight()).toBe(1);
    });

    it('is settled as unknown rather than failed', async () => {
      /* "It failed" is a claim about the provider. What happened is that we
       * stopped listening, and it may well have succeeded and been billed. */
      await calls.begin({
        enterpriseId,
        provider: 'openai',
        model: 'gpt-6-luna',
        purpose: ModelCallPurpose.AutoReply,
      });
      await db.query(`UPDATE model_calls SET created_at = now() - interval '1 hour'`);

      await expect(calls.settleAbandoned(60_000)).resolves.toBe(1);

      /* The row was backdated, so the window has to reach back past it. */
      const [row] = await calls.spendFor(enterpriseId, new Date(Date.now() - 2 * 60 * 60_000));
      expect(row).toMatchObject({ unknown: 1, failed: 0 });
    });

    it('leaves a call that is merely slow alone', async () => {
      await calls.begin({
        enterpriseId,
        provider: 'openai',
        model: 'gpt-6-luna',
        purpose: ModelCallPurpose.AutoReply,
      });

      await expect(calls.settleAbandoned(60_000)).resolves.toBe(0);
      expect(await inFlight()).toBe(1);
    });

    it('never reopens one that was already settled', async () => {
      const id = await call();
      await db.query(`UPDATE model_calls SET created_at = now() - interval '1 hour'`);

      await expect(calls.settleAbandoned(60_000)).resolves.toBe(0);
      const [row] = await calls.spendFor(enterpriseId, new Date(Date.now() - 2 * 60 * 60_000));
      expect(row?.unknown).toBe(0);
      expect(id).toBeGreaterThan(0);
    });
  });

  async function inFlight(): Promise<number> {
    const rows = await db.query<{ n: string }[]>(
      `SELECT COUNT(*) AS n FROM model_calls WHERE status = 'in_flight'`,
    );
    return Number(rows[0]?.n ?? 0);
  }
});
