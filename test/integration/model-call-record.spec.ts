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

  const call = (over: Partial<Parameters<ModelCallRepository['record']>[0]> = {}) =>
    calls.record({
      enterpriseId,
      provider: 'openai',
      model: 'gpt-6-luna',
      purpose: ModelCallPurpose.AutoReply,
      status: ModelCallStatus.Ok,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      durationMs: 850,
      ...over,
    });

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
    await call({ status: ModelCallStatus.Failed, failureCode: 'CHAT_TIMEOUT', outputTokens: 0 });
    await call({ status: ModelCallStatus.Failed, failureCode: 'CHAT_TIMEOUT', outputTokens: 0 });
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
  it('swallows its own failure rather than failing the call it is recording', async () => {
    await expect(
      calls.record({
        enterpriseId,
        provider: 'openai',
        /* Longer than the column, so the insert is refused by Postgres. */
        model: 'm'.repeat(200),
        purpose: ModelCallPurpose.AutoReply,
        status: ModelCallStatus.Ok,
      }),
    ).resolves.toBeUndefined();

    expect(await calls.spendFor(enterpriseId, since())).toEqual([]);
  });
});
