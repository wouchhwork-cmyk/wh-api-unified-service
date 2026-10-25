import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { RewardEntitlementRepository } from '@/database/repositories/reward-entitlement.repository';
import { RewardEntitlementStatus } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * Entitlements that lapse, and the terminal state nothing could reach.
 *
 * `expires_at` was written on every issue and read by NOTHING. An entitlement
 * whose window had closed stayed `issued` for ever, and the customer's balance
 * kept presenting it as a right the business still owed — so
 * `RewardEntitlementStatus.Expired` was declared and unreachable. A state
 * machine with a terminal state nothing can reach is not finished, it only
 * looks it.
 *
 * These tests exist in the shape SOP checkpoint 15 asks for: the control is
 * driven until it fires, and the states it must NOT touch are pinned beside it.
 */
describe('expiring lapsed entitlements', () => {
  let db: DataSource;
  let entitlements: RewardEntitlementRepository;
  let enterpriseId: number;
  let customerId: number;
  let awardId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    entitlements = new RewardEntitlementRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');

    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, first_source, status)
       VALUES ($1,'direct_message','active') RETURNING id`,
      [enterpriseId],
    );
    customerId = Number(customer[0]?.id);

    /*
     * An entitlement hangs off an AWARD — `award_id` is NOT NULL, because an
     * issued right always has a rule that decided it. So the fixture builds
     * the real chain rather than inventing an orphan the schema would refuse.
     */
    const program: { id: string }[] = await db.query(
      `INSERT INTO reward_programs (enterprise_id, name)
       VALUES ($1,'Social Rewards') RETURNING id`,
      [enterpriseId],
    );
    const rule: { id: string }[] = await db.query(
      `INSERT INTO reward_rules (enterprise_id, program_id, trigger_kind)
       VALUES ($1,$2,'story_mention') RETURNING id`,
      [enterpriseId, program[0]?.id],
    );
    const award: { id: string }[] = await db.query(
      `INSERT INTO reward_awards
         (enterprise_id, program_id, rule_id, rule_version, customer_id,
          source_ref_kind, source_ref_id, status, occurred_at_utc)
       VALUES ($1,$2,$3,1,$4,'message',1,'granted', now()) RETURNING id`,
      [enterpriseId, program[0]?.id, rule[0]?.id, customerId],
    );
    awardId = Number(award[0]?.id);
  });

  /** `expiresAt` is relative, so these read as "lapsed" and "still live". */
  const issue = async (
    itemRef: string,
    expiresInHours: number | null,
    status: RewardEntitlementStatus = RewardEntitlementStatus.Issued,
  ): Promise<number> => {
    const row: { id: string }[] = await db.query(
      `INSERT INTO reward_entitlements
         (enterprise_id, customer_id, award_id, item_ref, redemption_code, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,
               CASE WHEN $7::int IS NULL THEN NULL
                    ELSE now() + ($7::int * interval '1 hour') END)
       RETURNING id`,
      [enterpriseId, customerId, awardId, itemRef, `CODE-${itemRef}`, status, expiresInHours],
    );
    return Number(row[0]?.id);
  };

  const statusOf = async (id: number): Promise<string> => {
    const row: { status: string }[] = await db.query(
      `SELECT status FROM reward_entitlements WHERE id = $1`,
      [id],
    );
    return row[0]?.status ?? '';
  };

  it('moves a lapsed entitlement to expired', async () => {
    const id = await issue('FREE_COFFEE', -1);

    expect(await entitlements.expireLapsed(100)).toBe(1);
    expect(await statusOf(id)).toBe(RewardEntitlementStatus.Expired);
  });

  it('leaves one whose window is still open', async () => {
    const id = await issue('FREE_COFFEE', 24);

    expect(await entitlements.expireLapsed(100)).toBe(0);
    expect(await statusOf(id)).toBe(RewardEntitlementStatus.Issued);
  });

  /** NULL is "no expiry", not "expired at the epoch". */
  it('never expires one with no expiry at all', async () => {
    const id = await issue('FOREVER', null);

    expect(await entitlements.expireLapsed(100)).toBe(0);
    expect(await statusOf(id)).toBe(RewardEntitlementStatus.Issued);
  });

  /**
   * A terminal state must not be relabelled. What happened to a redeemed or
   * revoked entitlement is precisely what its status exists to record, and
   * overwriting it with `expired` would erase that it was ever honoured.
   */
  it('does not touch an entitlement that already reached a terminal state', async () => {
    const redeemed = await issue('REDEEMED', -1, RewardEntitlementStatus.Redeemed);
    const revoked = await issue('REVOKED', -1, RewardEntitlementStatus.Revoked);

    expect(await entitlements.expireLapsed(100)).toBe(0);
    expect(await statusOf(redeemed)).toBe(RewardEntitlementStatus.Redeemed);
    expect(await statusOf(revoked)).toBe(RewardEntitlementStatus.Revoked);
  });

  /** Batched, so one pass cannot be mistaken for "everything is swept". */
  it('respects the batch limit and sweeps the oldest first', async () => {
    await issue('A', -72);
    await issue('B', -48);
    await issue('C', -24);

    expect(await entitlements.expireLapsed(2)).toBe(2);
    const remaining: { item_ref: string }[] = await db.query(
      `SELECT item_ref FROM reward_entitlements WHERE status = $1`,
      [RewardEntitlementStatus.Issued],
    );
    /* C lapsed most recently, so it is the one left for the next pass. */
    expect(remaining.map((r) => r.item_ref)).toEqual(['C']);
  });

  it('is idempotent — a second pass finds nothing left to do', async () => {
    await issue('FREE_COFFEE', -1);

    expect(await entitlements.expireLapsed(100)).toBe(1);
    expect(await entitlements.expireLapsed(100)).toBe(0);
  });
});
