import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recomputes two counters that had never been written to.
 *
 * `customers.conversation_count` and `customer_engagements.conversation_count`
 * were both declared DEFAULT 0 and no code ever incremented either, so they
 * read 0 for every customer who had ever had a conversation — sitting beside
 * message counts that WERE being maintained, which is what made them
 * convincing. The directory endpoint had already worked around it by counting
 * conversations in a subquery.
 *
 * The code now maintains both from the moment a conversation is created. This
 * repairs the history behind that.
 *
 * DATA ONLY — no schema change, so there is nothing to deploy in order. It sets
 * absolute values computed from the conversations table rather than adding to
 * what is there, so running it twice is the same as running it once.
 */
export class RepairConversationCounts1757100000000 implements MigrationInterface {
  name = 'RepairConversationCounts1757100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE customers c
         SET conversation_count = COALESCE(counted.total, 0),
             updated_at = c.updated_at
        FROM (
          SELECT cu.id,
                 (SELECT count(*) FROM conversations cv
                   WHERE cv.customer_id = cu.id
                     AND cv.enterprise_id = cu.enterprise_id
                     AND cv.is_deleted = false) AS total
            FROM customers cu
        ) AS counted
       WHERE c.id = counted.id
         AND c.conversation_count IS DISTINCT FROM COALESCE(counted.total, 0)
    `);

    // Per channel, which is what this table is for: the same person reached
    // through a Page and through an Instagram account is two rows.
    await q.query(`
      UPDATE customer_engagements e
         SET conversation_count = COALESCE(counted.total, 0),
             updated_at = e.updated_at
        FROM (
          SELECT en.id,
                 (SELECT count(*) FROM conversations cv
                   WHERE cv.customer_id = en.customer_id
                     AND cv.channel_id = en.channel_id
                     AND cv.enterprise_id = en.enterprise_id
                     AND cv.is_deleted = false) AS total
            FROM customer_engagements en
        ) AS counted
       WHERE e.id = counted.id
         AND e.conversation_count IS DISTINCT FROM COALESCE(counted.total, 0)
    `);
  }

  /**
   * Nothing to undo. Restoring the wrong numbers would be vandalism, and the
   * columns are recomputable from conversations at any time.
   */
  public async down(): Promise<void> {
    return Promise.resolve();
  }
}
