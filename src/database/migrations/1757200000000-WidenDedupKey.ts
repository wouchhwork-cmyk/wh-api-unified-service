import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * dedup_key: VARCHAR(200) -> VARCHAR(500).
 *
 * An Instagram message id is about 170 characters, so
 * `instagram:direct_message:<mid>` already occupied 196 of the 200 available.
 * Four characters of headroom, and nothing anywhere said so — the first event
 * that needed a verb to distinguish it from the message it concerns (a
 * reaction, an unsend, a read receipt) overflowed, the insert failed, and the
 * webhook still answered 200. Meta considers those delivered and never resends
 * them.
 *
 * Widening rather than shortening the scheme, so every key already stored stays
 * exactly as it is and nothing is re-ingested under a new one. The composer now
 * also hashes an identity past 400 characters, so this cannot come back if a
 * platform id grows again.
 *
 * SAFE IN BOTH DIRECTIONS: widening a varchar is a metadata-only change in
 * Postgres — no table rewrite, no lock beyond the catalogue update — and every
 * existing value fits the new bound trivially.
 */
export class WidenDedupKey1757200000000 implements MigrationInterface {
  name = 'WidenDedupKey1757200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE inbound_events ALTER COLUMN dedup_key TYPE VARCHAR(500)`);
    await q.query(`ALTER TABLE outbound_events ALTER COLUMN dedup_key TYPE VARCHAR(500)`);
  }

  /**
   * Narrowing again would fail on any row that used the new room, which is the
   * correct outcome: those rows are real events and truncating their keys would
   * merge distinct ones. Rolling back means dropping them first, deliberately.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE inbound_events ALTER COLUMN dedup_key TYPE VARCHAR(200)`);
    await q.query(`ALTER TABLE outbound_events ALTER COLUMN dedup_key TYPE VARCHAR(200)`);
  }
}
