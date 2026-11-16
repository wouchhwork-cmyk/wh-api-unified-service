import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The platform's read on somebody, taken off the customer.
 *
 * THE SAME COLLAPSE THE NAMES HAD, hiding in a jsonb bag. `followsUs`,
 * `weFollowThem`, `isVerified` and `followerCount` are answers about an
 * ACCOUNT, and they were merged onto the customer — so whichever platform
 * refreshed last overwrote the others. Somebody who follows a business on
 * Instagram and not on Facebook has two true answers, and one slot held one
 * of them.
 *
 * Harder to notice than the names, because nothing displays a follow flag
 * next to the platform it came from: it simply reads as a fact about the
 * person, and the wrong one looks exactly like the right one.
 *
 * NOTHING IS LOST HERE. The profile rows were created with a copy of this
 * bag, so the keys being removed already exist per account. `profileFetchedAt`
 * goes with them: the profile has a real `fetched_at` column, and a
 * timestamp dug out of jsonb by the one caller that needed it was always the
 * worse of the two.
 *
 * The bag itself stays. It is the customer's own, several things merge into
 * it, and emptying it would be a different decision from removing the five
 * keys that were never the customer's to hold.
 */
export class CustomerMetadataSplit1760900000000 implements MigrationInterface {
  name = 'CustomerMetadataSplit1760900000000';

  private static readonly PLATFORM_KEYS = [
    'followsUs',
    'weFollowThem',
    'isVerified',
    'followerCount',
    'profileFetchedAt',
  ];

  public async up(q: QueryRunner): Promise<void> {
    /*
     * Only where a profile already holds them, so a customer whose keys were
     * never copied keeps what it has rather than losing it to a tidy-up.
     */
    await q.query(
      `UPDATE customers cu
          SET metadata = cu.metadata - $1::text[], updated_at = now()
        WHERE cu.metadata ?| $1::text[]
          AND EXISTS (
            SELECT 1 FROM customer_platform_profiles pp
             WHERE pp.enterprise_id = cu.enterprise_id
               AND pp.customer_id = cu.id
               AND pp.is_deleted = false
          )`,
      [CustomerMetadataSplit1760900000000.PLATFORM_KEYS],
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    /* Back from the freshest profile, so reverting restores what it removed. */
    await q.query(`
      UPDATE customers cu
         SET metadata = pp.metadata || cu.metadata
        FROM (
          SELECT DISTINCT ON (enterprise_id, customer_id)
                 enterprise_id, customer_id, metadata
            FROM customer_platform_profiles
           WHERE is_deleted = false
           ORDER BY enterprise_id, customer_id, fetched_at DESC NULLS LAST, id DESC
        ) pp
       WHERE pp.enterprise_id = cu.enterprise_id AND pp.customer_id = cu.id
    `);
  }
}
