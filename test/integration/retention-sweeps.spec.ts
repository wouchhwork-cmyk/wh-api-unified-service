import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { SessionRepository } from '@/database/repositories/session.repository';
import { VerificationRepository } from '@/database/repositories/verification.repository';
import { createTestDataSource, truncateTenantData } from './db.harness';

/**
 * The two retention sweeps, against real Postgres.
 *
 * Both were rewritten to use indexes, and an index only changes which rows the
 * planner VISITS — so the thing worth pinning is that it did not quietly change
 * which rows are DELETED. A retention sweep that keeps too much is a slow leak;
 * one that deletes too much signs people out and voids codes they are holding.
 *
 * Each sweep is two disjoint statements, and "disjoint" is the claim under
 * test: every row must be reachable by exactly one half, or rows survive
 * forever in the gap between them.
 */
describe('retention sweeps', () => {
  let db: DataSource;
  let sessions: SessionRepository;
  let verifications: VerificationRepository;
  let identityId: number;

  const CUTOFF = new Date('2026-06-01T00:00:00Z');
  const OLD = '2026-01-01T00:00:00Z';
  const RECENT = '2026-09-01T00:00:00Z';
  const LIMIT = 500;

  beforeAll(async () => {
    db = await createTestDataSource();
    sessions = new SessionRepository(db);
    verifications = new VerificationRepository(db);
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
