import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * Tenant isolation, enforced by the DATABASE rather than by a predicate
 * somebody has to remember.
 *
 * Every reward foreign key routes through enterprise_id, so a child row cannot
 * name another tenant's parent even if a query forgets its WHERE clause.
 *
 * AND THE BLIND SPOT THIS SUITE EXISTS FOR: "can A read B's row?" is the easy
 * half. The half that catches real bugs is "can A use its OWN row to reach
 * something of B's" — a wallet belonging to A pointing at B's customer, an
 * award of A's hanging off B's rule.
 */
describe('reward tenant isolation', () => {
  let db: DataSource;
  let acme: { enterpriseId: number; programId: number; ruleId: number; customerId: number };
  let zenith: { enterpriseId: number; programId: number; ruleId: number; customerId: number };

  beforeAll(async () => {
    db = await createTestDataSource();
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function seedTenant(name: string, slug: string) {
    const enterpriseId = await seedEnterprise(db, name, slug);
    const [program] = await db.query(
      `INSERT INTO reward_programs (enterprise_id, name)
       VALUES ($1, 'Rewards') RETURNING id`,
      [enterpriseId],
    );
    const [rule] = await db.query(
      `INSERT INTO reward_rules (enterprise_id, program_id, trigger_kind)
       VALUES ($1, $2, 'story_mention') RETURNING id`,
      [enterpriseId, Number(program.id)],
    );
    const [customer] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source)
       VALUES ($1, $2, 'instagram') RETURNING id`,
      [enterpriseId, name + ' customer'],
    );
    return {
      enterpriseId,
      programId: Number(program.id),
      ruleId: Number(rule.id),
      customerId: Number(customer.id),
    };
  }

  beforeEach(async () => {
    await truncateTenantData(db);
    acme = await seedTenant('Acme', 'acme');
    zenith = await seedTenant('Zenith', 'zenith');
  });

  it('refuses a rule naming another tenant’s program', async () => {
    await expect(
      db.query(
        `INSERT INTO reward_rules (enterprise_id, program_id, trigger_kind)
         VALUES ($1, $2, 'story_mention')`,
        [acme.enterpriseId, zenith.programId],
      ),
    ).rejects.toThrow();
  });

  it('refuses a wallet naming another tenant’s customer', async () => {
    await expect(
      db.query(
        `INSERT INTO reward_wallets (enterprise_id, customer_id, wallet_kind)
         VALUES ($1, $2, 'points')`,
        [acme.enterpriseId, zenith.customerId],
      ),
    ).rejects.toThrow();
  });

  it('refuses an award hanging off another tenant’s rule', async () => {
    await expect(
      db.query(
        `INSERT INTO reward_awards
                (enterprise_id, program_id, rule_id, rule_version, customer_id,
                 source_ref_kind, source_ref_id, status, occurred_at_utc)
         VALUES ($1, $2, $3, 1, $4, 'message', 1, 'held', now())`,
        [acme.enterpriseId, acme.programId, zenith.ruleId, acme.customerId],
      ),
    ).rejects.toThrow();
  });

  it('refuses a cap counter against another tenant’s customer', async () => {
    await expect(
      db.query(
        `INSERT INTO reward_cap_counters
                (enterprise_id, program_id, rule_id, customer_id, period_key, used, cap)
         VALUES ($1, $2, $3, $4, 'LIFETIME', 1, 1)`,
        [acme.enterpriseId, acme.programId, acme.ruleId, zenith.customerId],
      ),
    ).rejects.toThrow();
  });

  it('refuses a ledger entry against another tenant’s wallet', async () => {
    const [wallet] = await db.query(
      `INSERT INTO reward_wallets (enterprise_id, customer_id, wallet_kind)
       VALUES ($1, $2, 'points') RETURNING id`,
      [zenith.enterpriseId, zenith.customerId],
    );
    await expect(
      db.query(
        `INSERT INTO reward_ledger_entries
                (enterprise_id, wallet_id, entry_kind, amount, balance_after,
                 idempotency_key, occurred_at_utc)
         VALUES ($1, $2, 'earn', 10, 10, 'cross', now())`,
        [acme.enterpriseId, Number(wallet.id)],
      ),
    ).rejects.toThrow();
  });

  /**
   * The same cap period for the same rule is per TENANT as well as per
   * customer, so one business exhausting a slot cannot affect another's.
   */
  it('keeps cap counters separate across tenants', async () => {
    const claim = (t: typeof acme): Promise<unknown[]> =>
      db.query(
        `INSERT INTO reward_cap_counters
                (enterprise_id, program_id, rule_id, customer_id, period_key, used, cap)
         VALUES ($1, $2, $3, $4, '2026-W43', 1, 1)
         ON CONFLICT (enterprise_id, rule_id, customer_id, period_key)
         DO UPDATE SET used = reward_cap_counters.used + 1
               WHERE reward_cap_counters.used < reward_cap_counters.cap
         RETURNING used`,
        [t.enterpriseId, t.programId, t.ruleId, t.customerId],
      );

    expect(await claim(acme)).toHaveLength(1);
    expect(await claim(zenith)).toHaveLength(1);
    expect(await claim(acme)).toHaveLength(0);
  });

  /** A program name is unique per tenant, not globally. */
  it('lets two tenants use the same program name', async () => {
    await db.query(
      `INSERT INTO reward_programs (enterprise_id, name)
       VALUES ($1, 'Summer Campaign')`,
      [acme.enterpriseId],
    );
    await expect(
      db.query(
        `INSERT INTO reward_programs (enterprise_id, name)
         VALUES ($1, 'Summer Campaign')`,
        [zenith.enterpriseId],
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a duplicate program name within one tenant', async () => {
    await db.query(
      `INSERT INTO reward_programs (enterprise_id, name)
       VALUES ($1, 'Summer Campaign')`,
      [acme.enterpriseId],
    );
    await expect(
      db.query(
        `INSERT INTO reward_programs (enterprise_id, name)
         VALUES ($1, 'summer campaign')`,
        [acme.enterpriseId],
      ),
    ).rejects.toThrow();
  });
});
