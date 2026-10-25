import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { seedCatalogue } from '@/database/seed/catalogue.seed';
import { FeatureKey, Permission } from '@/shared/enums';
import { createTestDataSource } from './db.harness';

/**
 * A permission whose GATE changed, on a database that already has the row.
 *
 * The catalogue inserts with `ON CONFLICT DO NOTHING`, which is right for a
 * description or a scope — and was silently wrong for `feature_id`. `rewards.*`
 * shipped with no feature behind it; pointing the catalogue at a real feature
 * fixed every fresh database and nothing else, because the insert skips the row
 * that already exists.
 *
 * So the seed now corrects the gate, and this is the proof: the correction is
 * what makes the platform admin's switch mean anything on an existing tenant.
 */
describe('the catalogue seed re-gating a permission', () => {
  let db: DataSource;

  beforeAll(async () => {
    db = await createTestDataSource();
  });
  afterAll(async () => {
    await db.destroy();
  });

  const gateOf = async (code: Permission): Promise<string | null> => {
    const rows = await db.query<{ key: string | null }[]>(
      `SELECT f."key"
         FROM permissions p
         LEFT JOIN features f ON f.id = p.feature_id
        WHERE p.code = $1 AND p.is_deleted = false`,
      [code],
    );
    return rows[0]?.key ?? null;
  };

  it('points the rewards permissions at the reward_programs feature', async () => {
    await db.transaction((manager) => seedCatalogue(manager));

    expect(await gateOf(Permission.RewardsView)).toBe(FeatureKey.RewardPrograms);
    expect(await gateOf(Permission.RewardsManage)).toBe(FeatureKey.RewardPrograms);
    expect(await gateOf(Permission.RewardsAdjust)).toBe(FeatureKey.RewardPrograms);
  });

  /**
   * THE CASE THE INSERT CANNOT REACH.
   *
   * An ungated row is exactly what a database seeded before this change holds,
   * and re-running the catalogue against it used to be a no-op.
   */
  it('corrects a gate that was already written as NULL', async () => {
    await db.query(`UPDATE permissions SET feature_id = NULL WHERE code = $1`, [
      Permission.RewardsView,
    ]);
    expect(await gateOf(Permission.RewardsView)).toBeNull();

    await db.transaction((manager) => seedCatalogue(manager));

    expect(await gateOf(Permission.RewardsView)).toBe(FeatureKey.RewardPrograms);
  });

  /** An ungated resource stays ungated: running the account is not a feature. */
  it('leaves a deliberately ungated permission alone', async () => {
    await db.transaction((manager) => seedCatalogue(manager));
    expect(await gateOf(Permission.RolesView)).toBeNull();
  });
});
