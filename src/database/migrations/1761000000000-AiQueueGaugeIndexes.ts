import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the queue gauge needs to read the two AI queues cheaply.
 *
 * The gauge runs every minute and counts, per queue, what is leased and what
 * has been given up on. The transport ledgers have partial indexes for
 * exactly those predicates; the AI ledgers did not, because nothing counted
 * them — they were invisible to the gauge entirely, which is the hole this
 * closes. Adding the queues without the indexes would trade a blind spot for
 * two sequential scans a minute over tables that grow with every message.
 *
 * PARTIAL, so each index is the size of the problem rather than of the
 * traffic. `in_flight` is a handful of rows at any instant and `unavailable`
 * is the failures — both tiny next to the done-and-settled bulk they sit in.
 *
 * `media_analyses` needs only the first: its existing stats index over
 * (status, media_kind) already answers a count of terminal rows.
 */
export class AiQueueGaugeIndexes1761000000000 implements MigrationInterface {
  name = 'AiQueueGaugeIndexes1761000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS assistant_replies_in_flight_idx
      ON assistant_replies (lease_expires_at)
      WHERE status = 'in_flight'
    `);

    /* Ordered by when it was settled, because the alarm reads a window of
       recent failures rather than the cumulative count. */
    await q.query(`
      CREATE INDEX IF NOT EXISTS assistant_replies_unavailable_idx
      ON assistant_replies (settled_at DESC)
      WHERE status = 'unavailable'
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS media_analyses_in_flight_idx
      ON media_analyses (lease_expires_at)
      WHERE status = 'in_flight'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS assistant_replies_in_flight_idx`);
    await q.query(`DROP INDEX IF EXISTS assistant_replies_unavailable_idx`);
    await q.query(`DROP INDEX IF EXISTS media_analyses_in_flight_idx`);
  }
}
