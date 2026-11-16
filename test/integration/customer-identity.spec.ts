import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { IdentifierKind, Platform } from '@/shared/enums';
import {
  createTestDataSource,
  returningRows,
  seedEnterprise,
  truncateTenantData,
} from './db.harness';

/**
 * Whose name is whose, against real Postgres.
 *
 * There used to be one name slot and the platform owned it: a profile
 * refresh wrote straight onto the customer, so the last platform to answer
 * won and anything a colleague typed would have been overwritten without a
 * word. These are the guarantees that replaced it.
 */
describe('a customer name and the platform it came from', () => {
  let db: DataSource;
  let customers: CustomerRepository;
  let enterpriseId: number;
  let customerId: number;
  let instagramId: number;
  let facebookId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    customers = new CustomerRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Split Co', 'split-co');

    customerId = Number(
      returningRows<{ id: string }>(
        await db.query(
          `INSERT INTO customers (enterprise_id, first_source, status)
           VALUES ($1,'instagram_dm','active') RETURNING id`,
          [enterpriseId],
        ),
      )[0]?.id,
    );

    instagramId = await seedIdentifier(IdentifierKind.InstagramUserId, 'ig-scoped-1');
    facebookId = await seedIdentifier(IdentifierKind.FacebookUserId, 'fb-scoped-1');
  });

  async function seedIdentifier(kind: IdentifierKind, value: string): Promise<number> {
    const rows = returningRows<{ id: string }>(
      await db.query(
        `INSERT INTO customer_identifiers
           (enterprise_id, customer_id, identifier_kind, identifier_value, source, status)
         VALUES ($1,$2,$3,$4,'platform','active') RETURNING id`,
        [enterpriseId, customerId, kind, value],
      ),
    );
    return Number(rows[0]?.id);
  }

  const apply = (over: Partial<Parameters<CustomerRepository['applyPlatformProfile']>[0]> = {}) =>
    customers.applyPlatformProfile({
      enterpriseId,
      customerId,
      platform: Platform.Instagram,
      customerIdentifierId: instagramId,
      displayName: 'Insta Name',
      firstName: null,
      lastName: null,
      avatarUrl: 'https://cdn.test/ig.jpg',
      profile: { followerCount: 10 },
      ...over,
    });

  const ourName = (name: string | null) =>
    db.query(`UPDATE customers SET display_name = $2 WHERE id = $1`, [customerId, name]);

  const resolved = () => customers.assistantProfile(enterpriseId, customerId, instagramId);

  describe('one profile per account', () => {
    it('keeps the two platforms apart instead of overwriting', async () => {
      await apply();
      await apply({
        platform: Platform.Facebook,
        customerIdentifierId: facebookId,
        displayName: 'Facebook Name',
        avatarUrl: 'https://cdn.test/fb.jpg',
      });

      const rows = await db.query<{ platform: string; display_name: string }[]>(
        `SELECT platform, display_name FROM customer_platform_profiles
          WHERE customer_id = $1 ORDER BY platform`,
        [customerId],
      );
      expect(rows).toEqual([
        { platform: 'facebook', display_name: 'Facebook Name' },
        { platform: 'instagram', display_name: 'Insta Name' },
      ]);
    });

    it('updates the account it already has rather than adding another', async () => {
      await apply();
      await apply({ displayName: 'Renamed' });

      const rows = await db.query<{ n: string }[]>(
        `SELECT count(*) AS n FROM customer_platform_profiles WHERE customer_id = $1`,
        [customerId],
      );
      expect(Number(rows[0]?.n)).toBe(1);
    });

    it('never erases what an earlier refresh learned', async () => {
      await apply();
      /* A refresh that returned a name but no picture must not blank it. */
      await apply({ displayName: 'Still Them', avatarUrl: null, profile: { isVerified: true } });

      const rows = await db.query<{ avatar_url: string; metadata: Record<string, unknown> }[]>(
        `SELECT avatar_url, metadata FROM customer_platform_profiles WHERE customer_id = $1`,
        [customerId],
      );
      expect(rows[0]?.avatar_url).toBe('https://cdn.test/ig.jpg');
      expect(rows[0]?.metadata).toMatchObject({ followerCount: 10, isVerified: true });
    });
  });

  describe('which name wins', () => {
    it('falls back to the platform when this business holds none', async () => {
      await apply();
      await expect(resolved()).resolves.toMatchObject({ displayName: 'Insta Name' });
    });

    /**
     * THE BUG THIS EXISTS FOR. The old write was
     * `display_name = COALESCE($3, display_name)` straight onto the customer,
     * so the next profile refresh silently replaced whatever a colleague had
     * typed.
     */
    it('prefers what this business holds, and a refresh cannot take it back', async () => {
      await ourName('What We Call Them');
      await apply({ displayName: 'Platform Would Overwrite' });

      await expect(resolved()).resolves.toMatchObject({ displayName: 'What We Call Them' });
    });

    it('shows the name from the account they are writing from', async () => {
      await apply();
      await apply({
        platform: Platform.Facebook,
        customerIdentifierId: facebookId,
        displayName: 'Facebook Name',
      });

      await expect(
        customers.assistantProfile(enterpriseId, customerId, facebookId),
      ).resolves.toMatchObject({ displayName: 'Facebook Name' });
      await expect(
        customers.assistantProfile(enterpriseId, customerId, instagramId),
      ).resolves.toMatchObject({ displayName: 'Insta Name' });
    });

    it('takes the freshest when no account is named', async () => {
      await apply();
      await apply({
        platform: Platform.Facebook,
        customerIdentifierId: facebookId,
        displayName: 'Facebook Name',
      });

      await expect(
        customers.assistantProfile(enterpriseId, customerId, null),
      ).resolves.toMatchObject({ displayName: 'Facebook Name' });
    });
  });

  describe('resolving the account when a caller cannot name it', () => {
    it('prefers the stable id over the handle', async () => {
      /* People change their handle. A profile filed under the old one is a
       * profile nobody finds again. */
      const handleId = await seedIdentifier(IdentifierKind.InstagramUsername, 'their_handle');

      await expect(
        customers.accountIdentifierFor(enterpriseId, customerId, Platform.Instagram),
      ).resolves.toBe(instagramId);
      expect(handleId).toBeGreaterThan(0);
    });

    it('uses the handle only where no account id was ever recorded', async () => {
      await db.query(`DELETE FROM customer_identifiers WHERE id = $1`, [instagramId]);
      const handleId = await seedIdentifier(IdentifierKind.InstagramUsername, 'their_handle');

      await expect(
        customers.accountIdentifierFor(enterpriseId, customerId, Platform.Instagram),
      ).resolves.toBe(handleId);
    });

    it('records nothing at all when there is no account to attach to', async () => {
      await db.query(`DELETE FROM customer_identifiers WHERE customer_id = $1`, [customerId]);

      await expect(apply({ customerIdentifierId: null })).resolves.toBe(false);
    });
  });

  describe('finding people by name', () => {
    /**
     * The whole of customer search read `customers.display_name`. With the
     * names moved, that column is null for everybody who arrived through a
     * platform — which is everybody — so a search reading only it returns
     * nothing, silently.
     */
    it('finds somebody by the name the platform gave them', async () => {
      await apply({ displayName: 'Findable Person' });

      const found = await customers.searchByName(enterpriseId, 'Findable', 10);
      expect(found.map((row) => row.displayName)).toEqual(['Findable Person']);
    });

    it('finds somebody by the name this business gave them', async () => {
      await apply({ displayName: 'Platform Name' });
      await ourName('Our Own Name');

      const found = await customers.searchByName(enterpriseId, 'Our Own', 10);
      expect(found.map((row) => row.displayName)).toEqual(['Our Own Name']);
    });

    it('still finds them under an old platform name they no longer show', async () => {
      await apply({ displayName: 'Old Platform Name' });
      await ourName('Our Own Name');

      /* The match is on a profile, the display is ours. Somebody searching
       * what they remember should still land on the right person. */
      const found = await customers.searchByName(enterpriseId, 'Old Platform', 10);
      expect(found.map((row) => row.displayName)).toEqual(['Our Own Name']);
    });
  });

  describe('the name this business gives them', () => {
    /**
     * THE OTHER HALF OF THE SPLIT. Until this existed nothing could write
     * the half that wins, so "ours outranks the platform's" was a rule that
     * could never fire — a fallback with no primary is just a slower way of
     * reading the platform.
     */
    it('is what everything shows once it is set', async () => {
      await apply({ displayName: 'Platform Name' });
      const changed = await customers.setOwnIdentity(enterpriseId, await refOf(), {
        displayName: 'What We Call Them',
      });

      expect(changed?.after.displayName).toBe('What We Call Them');
      await expect(resolved()).resolves.toMatchObject({ displayName: 'What We Call Them' });
    });

    it('reports what it replaced, not what was asked for', async () => {
      await customers.setOwnIdentity(enterpriseId, await refOf(), { displayName: 'First' });
      const second = await customers.setOwnIdentity(enterpriseId, await refOf(), {
        displayName: 'Second',
      });

      expect(second?.before.displayName).toBe('First');
      expect(second?.after.displayName).toBe('Second');
    });

    it('leaves a field alone when it is absent', async () => {
      await customers.setOwnIdentity(enterpriseId, await refOf(), {
        displayName: 'Kept',
        firstName: 'Also Kept',
      });
      await customers.setOwnIdentity(enterpriseId, await refOf(), { lastName: 'Added' });

      const after = await customers.setOwnIdentity(enterpriseId, await refOf(), {});
      expect(after?.after).toMatchObject({
        displayName: 'Kept',
        firstName: 'Also Kept',
        lastName: 'Added',
      });
    });

    it('hands the customer back to the platform when cleared', async () => {
      /* Null is not "no change": it is what somebody who typed a name by
       * mistake actually wants. */
      await apply({ displayName: 'Platform Name' });
      await customers.setOwnIdentity(enterpriseId, await refOf(), { displayName: 'Mistake' });
      await customers.setOwnIdentity(enterpriseId, await refOf(), { displayName: null });

      await expect(resolved()).resolves.toMatchObject({ displayName: 'Platform Name' });
    });

    it('refuses a customer belonging to another business', async () => {
      const otherId = await seedEnterprise(db, 'Rival Co', 'rival-co');
      await expect(
        customers.setOwnIdentity(otherId, await refOf(), { displayName: 'Theirs' }),
      ).resolves.toBeNull();
    });
  });

  async function refOf(): Promise<string> {
    const rows = await db.query<{ ref_id: string }[]>(
      `SELECT ref_id FROM customers WHERE id = $1`,
      [customerId],
    );
    return rows[0]?.ref_id ?? '';
  }
});
