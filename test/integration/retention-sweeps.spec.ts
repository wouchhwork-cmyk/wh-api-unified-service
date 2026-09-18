import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import { SessionRepository } from '@/database/repositories/session.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { VerificationRepository } from '@/database/repositories/verification.repository';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * Every retention sweep, against real Postgres.
 *
 * WHAT A SWEEP DELETES IS THE ONLY THING WORTH TESTING ABOUT IT. Keeping too
 * much is a slow leak nobody notices; deleting too much signs people out, voids
 * codes they are holding, or — on the ledgers — removes the row that was
 * stopping a redelivered webhook from being handled twice. None of those
 * announce themselves.
 *
 * Two groups, for two different reasons:
 *
 * - `sessions` and `verifications` were rewritten to use indexes, and an index
 *   changes which rows the planner VISITS. These pin that it did not also
 *   change which rows it removes. Each is two disjoint statements now, and
 *   "disjoint" is the claim: every row reachable by exactly one half, or rows
 *   survive forever in the gap between them.
 *
 * - the three ledgers had no retention at all and grew without bound. There the
 *   question is what may be swept, and the answer is narrower than "old":
 *   dead letters are evidence, claimable rows are work, and a settled row is
 *   still holding a dedup guarantee until the window passes.
 */
describe('retention sweeps', () => {
  let db: DataSource;
  let sessions: SessionRepository;
  let verifications: VerificationRepository;
  let inboundEvents: InboundEventRepository;
  let outboundEvents: OutboundEventRepository;
  let syncJobs: SyncJobRepository;
  let identityId: number;

  const CUTOFF = new Date('2026-06-01T00:00:00Z');
  const OLD = '2026-01-01T00:00:00Z';
  const RECENT = '2026-09-01T00:00:00Z';
  const LIMIT = 500;

  beforeAll(async () => {
    db = await createTestDataSource();
    sessions = new SessionRepository(db);
    verifications = new VerificationRepository(db);
    inboundEvents = new InboundEventRepository(db);
    outboundEvents = new OutboundEventRepository(db);
    syncJobs = new SyncJobRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    const identity: { id: string }[] = await db.query(
      `INSERT INTO identities (password_hash, first_name, email)
       VALUES ('x', 'Meera', 'meera@bluebottle.test') RETURNING id`,
    );
    identityId = Number(identity[0]?.id);
  });

  describe('sessions', () => {
    async function seed(
      label: string,
      expiresAt: string,
      revokedAt: string | null,
    ): Promise<void> {
      await db.query(
        `INSERT INTO sessions (identity_id, refresh_token_hash, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4)`,
        [identityId, label, expiresAt, revokedAt],
      );
    }

    const survivors = async (): Promise<string[]> => {
      const rows: { refresh_token_hash: string }[] = await db.query(
        `SELECT refresh_token_hash FROM sessions ORDER BY refresh_token_hash`,
      );
      return rows.map((row) => row.refresh_token_hash);
    };

    it('deletes what has aged out and keeps what has not', async () => {
      await seed('expired-not-revoked', OLD, null);
      await seed('revoked-long-ago', OLD, OLD);
      await seed('still-valid', RECENT, null);

      const deleted = await sessions.deleteExpiredBefore(CUTOFF, LIMIT);

      // Both halves reported, not just the last one to run.
      expect(deleted).toBe(2);
      expect(await survivors()).toEqual(['still-valid']);
    });

    it('keeps an expired session until its revocation has also aged out', async () => {
      /*
       * THE ONE BEHAVIOURAL CHANGE. Splitting on `revoked_at IS NULL` is what
       * lets the first half use its partial index, and it moves retention onto
       * the LATER of the two events. A session expired in January but revoked
       * yesterday is held until the revocation ages out — which is what
       * "delete N days after the last thing that happened" means.
       */
      await seed('expired-then-revoked-recently', OLD, RECENT);

      expect(await sessions.deleteExpiredBefore(CUTOFF, LIMIT)).toBe(0);
      expect(await survivors()).toEqual(['expired-then-revoked-recently']);
    });

    it('leaves no row unreachable by either half', async () => {
      // The gap a split can open: a row neither statement's predicate matches.
      await seed('expired-not-revoked', OLD, null);
      await seed('revoked-long-ago', RECENT, OLD);

      await sessions.deleteExpiredBefore(CUTOFF, LIMIT);

      expect(await survivors()).toEqual([]);
    });
  });

  describe('the three ledgers, which had no retention at all', () => {
    /**
     * These grew forever. They are the largest tables in the schema and the
     * only ones with a guaranteed daily floor under their growth — the
     * post-metrics refresh enqueues a job per channel every day whether
     * anything changed or not.
     *
     * The sweep has a correctness constraint the other tables do not:
     * `inbound_events_dedup_uniq` is what makes a webhook Meta sends twice
     * collide instead of being handled twice, and that protection lives in the
     * row. So what may be deleted, and what must not, is the whole test.
     */
    async function inbound(dedupKey: string, status: string, createdAt: string): Promise<void> {
      await db.query(
        `INSERT INTO inbound_events (source_kind, platform, event_type, dedup_key, status, created_at)
         VALUES ('webhook','instagram','messages',$1,$2,$3)`,
        [dedupKey, status, createdAt],
      );
    }

    const remaining = async (table: string): Promise<string[]> => {
      const rows: { dedup_key: string }[] = await db.query(
        `SELECT dedup_key FROM ${table} ORDER BY dedup_key`,
      );
      return rows.map((row) => row.dedup_key);
    };

    it('removes settled rows that are past the window', async () => {
      await inbound('old-processed', 'processed', OLD);
      await inbound('old-skipped', 'skipped', OLD);

      expect(await inboundEvents.deleteSettledBefore(CUTOFF, LIMIT)).toBe(2);
      expect(await remaining('inbound_events')).toEqual([]);
    });

    it('keeps a settled row that is still inside the window', async () => {
      // The window exists to outlast redelivery, so recency is what protects it.
      await inbound('recent-processed', 'processed', RECENT);

      expect(await inboundEvents.deleteSettledBefore(CUTOFF, LIMIT)).toBe(0);
      expect(await remaining('inbound_events')).toEqual(['recent-processed']);
    });

    it('never sweeps a dead letter, however old', async () => {
      /*
       * A terminal failure is a human's problem and the queue gauge alarms on
       * it. Sweeping it would erase the evidence and the alarm together — and
       * it would do so silently, since the gauge would simply read zero.
       */
      await inbound('ancient-poison', 'dead_letter', OLD);

      expect(await inboundEvents.deleteSettledBefore(CUTOFF, LIMIT)).toBe(0);
      expect(await remaining('inbound_events')).toEqual(['ancient-poison']);
    });

    it('never sweeps a row that is still claimable', async () => {
      // `failed` is retried, not finished. Deleting it would drop the work.
      await inbound('ancient-pending', 'pending', OLD);
      await inbound('ancient-failed', 'failed', OLD);

      expect(await inboundEvents.deleteSettledBefore(CUTOFF, LIMIT)).toBe(0);
      expect(await remaining('inbound_events')).toEqual(['ancient-failed', 'ancient-pending']);
    });

    it('leaves the dedup guard intact for anything it has not swept', async () => {
      /*
       * The point of the whole window. While the row is there, a redelivery of
       * the same webhook must still collide — that unique index is the only
       * thing standing between a Meta retry and a duplicate message in
       * somebody's inbox.
       */
      await inbound('replayed', 'processed', RECENT);
      await inboundEvents.deleteSettledBefore(CUTOFF, LIMIT);

      await expect(inbound('replayed', 'pending', RECENT)).rejects.toThrow();
    });

    it('sweeps the outbound ledger on the same terms', async () => {
      const outbound = (key: string, status: string, createdAt: string): Promise<unknown> =>
        db.query(
          `INSERT INTO outbound_events
             (destination_kind, platform, event_type, dedup_key, status, created_at)
           VALUES ('graph_api','instagram','reply',$1,$2,$3)`,
          [key, status, createdAt],
        );

      await outbound('old-sent', 'sent', OLD);
      await outbound('old-cancelled', 'cancelled', OLD);
      await outbound('old-poison', 'dead_letter', OLD);
      await outbound('old-pending', 'pending', OLD);

      expect(await outboundEvents.deleteSettledBefore(CUTOFF, LIMIT)).toBe(2);
      expect(await remaining('outbound_events')).toEqual(['old-pending', 'old-poison']);
    });

    it('sweeps settled sync jobs and leaves live ones', async () => {
      const connection: { id: string }[] = await db.query(
        `INSERT INTO provider_connections
           (enterprise_id, provider, provider_category, provider_user_id, access_token)
         VALUES ($1,'meta','social','fbu','envelope') RETURNING id`,
        [await seedEnterprise(db, 'Acme', 'acme')],
      );
      const owner: { id: string; enterprise_id: string }[] = await db.query(
        `SELECT id, enterprise_id FROM provider_connections WHERE id = $1`,
        [connection[0]?.id],
      );
      const channel: { id: string }[] = await db.query(
        `INSERT INTO channels
           (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
         VALUES ($1,$2,'instagram','instagram_business','IG_1') RETURNING id`,
        [owner[0]?.id, owner[0]?.enterprise_id],
      );

      const job = (kind: string, status: string, createdAt: string): Promise<unknown> =>
        db.query(
          `INSERT INTO sync_jobs
             (enterprise_id, channel_id, job_kind, trigger_kind, status, created_at)
           VALUES ($1,$2,$3,'scheduled',$4,$5)`,
          [owner[0]?.enterprise_id, channel[0]?.id, kind, status, createdAt],
        );

      await job('refresh_post_metrics', 'completed', OLD);
      await job('refresh_profile', 'cancelled', OLD);
      await job('backfill_posts', 'dead_letter', OLD);
      await job('backfill_comments', 'pending', OLD);

      expect(await syncJobs.deleteSettledBefore(CUTOFF, LIMIT)).toBe(2);

      const left: { status: string }[] = await db.query(
        `SELECT status FROM sync_jobs ORDER BY status`,
      );
      expect(left.map((row) => row.status)).toEqual(['dead_letter', 'pending']);
    });
  });

  describe('verifications', () => {
    async function seed(
      destination: string,
      expiresAt: string,
      consumedAt: string | null,
      isDeleted = false,
    ): Promise<void> {
      await db.query(
        `INSERT INTO verifications
           (subject_kind, identity_id, verification_kind, delivery_channel, destination,
            secret_hash, expires_at, consumed_at, last_sent_at, is_deleted)
         VALUES ('identity', $1, 'employee_invite', 'email', $2, 'x', $3, $4, now(), $5)`,
        [identityId, destination, expiresAt, consumedAt, isDeleted],
      );
    }

    const survivors = async (): Promise<string[]> => {
      const rows: { destination: string }[] = await db.query(
        `SELECT destination FROM verifications ORDER BY destination`,
      );
      return rows.map((row) => row.destination);
    };

    it('deletes settled rows and keeps live ones', async () => {
      await seed('consumed-long-ago', OLD, OLD);
      await seed('expired-unconsumed', OLD, null);
      await seed('still-live', RECENT, null);

      const deleted = await verifications.deleteSettledBefore(CUTOFF, LIMIT);

      expect(deleted).toBe(2);
      expect(await survivors()).toEqual(['still-live']);
    });

    it('keeps an expired code until its consumption has also aged out', async () => {
      // Same rule as sessions: retention runs from the later event.
      await seed('expired-then-consumed-recently', OLD, RECENT);

      expect(await verifications.deleteSettledBefore(CUTOFF, LIMIT)).toBe(0);
      expect(await survivors()).toEqual(['expired-then-consumed-recently']);
    });

    it('reaches soft-deleted rows, which are the ones retention exists for', async () => {
      /*
       * The widened index earns its place here. The old
       * `verifications_expiry_idx` was partial on `is_deleted = false`, so it
       * could never serve a sweep that has to remove soft-deleted rows — and a
       * sweep that skipped them would keep destinations and secret hashes
       * forever.
       */
      await seed('soft-deleted-and-expired', OLD, null, true);

      expect(await verifications.deleteSettledBefore(CUTOFF, LIMIT)).toBe(1);
      expect(await survivors()).toEqual([]);
    });
  });
});
