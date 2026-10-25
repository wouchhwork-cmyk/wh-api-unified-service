import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { RewardWalletRepository } from '@/database/repositories/reward-wallet.repository';
import { RewardEntryKind, RewardWalletKind } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * `debitIfSufficient` against real Postgres, because the whole guarantee is one
 * statement.
 *
 * A mocked repository would assert that the method was called, which is the one
 * thing never in doubt. What was in doubt — and wrong — is what the database
 * does when the same idempotency key arrives twice.
 */
describe('reward wallet debit', () => {
  let db: DataSource;
  let wallets: RewardWalletRepository;
  let enterpriseId: number;
  let customerId: number;
  let walletId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    wallets = new RewardWalletRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Debit Co', 'debit-co');

    const [customer] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source)
       VALUES ($1, 'Priya', 'instagram') RETURNING id`,
      [enterpriseId],
    );
    customerId = Number(customer.id);

    const wallet = await wallets.ensureCustomerWallet({
      enterpriseId,
      customerId,
      walletKind: RewardWalletKind.Points,
      currencyCode: null,
    });
    walletId = wallet.id;

    await wallets.credit({
      enterpriseId,
      walletId,
      entryKind: RewardEntryKind.Earn,
      amount: 100,
      idempotencyKey: 'seed:earn',
      occurredAtUtc: new Date(),
    });
  });

  const balance = async (): Promise<number> => {
    const [row] = await db.query(`SELECT balance FROM reward_wallets WHERE id = $1`, [walletId]);
    return Number(row.balance);
  };

  const entryCount = async (key: string): Promise<number> => {
    const [row] = await db.query(
      `SELECT count(*) AS n FROM reward_ledger_entries
        WHERE enterprise_id = $1 AND idempotency_key = $2`,
      [enterpriseId, key],
    );
    return Number(row.n);
  };

  const debit = (key: string, amount: number): Promise<unknown> =>
    wallets.debitIfSufficient({
      enterpriseId,
      walletId,
      entryKind: RewardEntryKind.ConvertOut,
      amount,
      idempotencyKey: key,
      occurredAtUtc: new Date(),
    });

  /**
   * THE DEFECT THIS FILE EXISTS FOR.
   *
   * Three identical debits under one key. Before the fix: the balance moved
   * three times (100 → 70 → 40 → 10) and ONE entry was written, because the
   * sufficiency check passed again on each replay and
   * `ON CONFLICT DO NOTHING` swallowed the duplicate insert silently.
   */
  it('moves the balance once when the same key arrives three times', async () => {
    const first = await debit('convert:abc:out', -30);
    const second = await debit('convert:abc:out', -30);
    const third = await debit('convert:abc:out', -30);

    expect(first).not.toBeNull();
    expect(await balance()).toBe(70);
    expect(await entryCount('convert:abc:out')).toBe(1);

    // Every replay hands back the entry the first call wrote, not a new one.
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  /**
   * A REFUSAL MUST NOT CLAIM THE KEY.
   *
   * This is the premise the fix turned on: the INSERT draws `FROM moved`, so
   * an UPDATE that matches nothing inserts nothing. If a refusal DID claim the
   * key, the retry below would be swallowed as a replay and the customer could
   * never convert under that key again.
   */
  it('leaves the key unclaimed when the funds are short, so a later retry works', async () => {
    const refused = await debit('convert:xyz:out', -500);
    expect(refused).toBeNull();
    expect(await balance()).toBe(100);
    expect(await entryCount('convert:xyz:out')).toBe(0);

    await wallets.credit({
      enterpriseId,
      walletId,
      entryKind: RewardEntryKind.Earn,
      amount: 500,
      idempotencyKey: 'seed:earn:more',
      occurredAtUtc: new Date(),
    });

    const allowed = await debit('convert:xyz:out', -500);
    expect(allowed).not.toBeNull();
    expect(await balance()).toBe(100);
    expect(await entryCount('convert:xyz:out')).toBe(1);
  });

  /** A debit of exactly the balance is sufficient; one unit more is not. */
  it('treats the balance as spendable down to zero and no further', async () => {
    expect(await debit('exact:out', -100)).not.toBeNull();
    expect(await balance()).toBe(0);

    expect(await debit('over:out', -1)).toBeNull();
    expect(await balance()).toBe(0);
  });

  /**
   * A wallet that is not this tenant's is a FAULT, not a refusal.
   *
   * It used to return null, so a cross-tenant wallet id reached the customer as
   * "not enough points" and left nothing behind to say what had really
   * happened.
   */
  it("throws rather than reporting a refusal when the wallet is another tenant's", async () => {
    const otherId = await seedEnterprise(db, 'Other Co', 'other-co');
    const [otherCustomer] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source)
       VALUES ($1, 'Sam', 'instagram') RETURNING id`,
      [otherId],
    );
    const otherWallet = await wallets.ensureCustomerWallet({
      enterpriseId: otherId,
      customerId: Number(otherCustomer.id),
      walletKind: RewardWalletKind.Points,
      currencyCode: null,
    });

    await expect(
      wallets.debitIfSufficient({
        enterpriseId,
        walletId: otherWallet.id,
        entryKind: RewardEntryKind.ConvertOut,
        amount: -10,
        idempotencyKey: 'cross:tenant:out',
        occurredAtUtc: new Date(),
      }),
    ).rejects.toThrow(/not found for this enterprise/);

    const [row] = await db.query(`SELECT balance FROM reward_wallets WHERE id = $1`, [
      otherWallet.id,
    ]);
    expect(Number(row.balance)).toBe(0);
  });

  /** The sign contract, kept from the original. */
  it('refuses a non-negative amount', async () => {
    await expect(debit('positive:out', 30)).rejects.toThrow(/negative amount/);
    await expect(debit('zero:out', 0)).rejects.toThrow(/negative amount/);
  });
});
