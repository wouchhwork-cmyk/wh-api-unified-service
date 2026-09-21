import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { EnterpriseFeatureRepository } from '@/database/repositories/enterprise-feature.repository';
import { EnterpriseFeatureStatus, FeatureKey } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The two halves of the feature model that were modelled and unreachable.
 *
 * `access_requested` is the FIRST state in `ENTERPRISE_FEATURE_TRANSITIONS` and
 * nothing could produce it — the only path into `enterprise_features` was a
 * platform admin granting a feature outright, so `features.request` was a dead
 * permission and a business could not see what it was missing, let alone ask.
 *
 * `expires_at` had an index — `enterprise_features_expiry_idx`, partial on
 * `status = 'active' AND expires_at IS NOT NULL`, present since the first
 * migration — for a sweep nobody wrote. A trial with a date in the past stayed
 * ACTIVE for ever and the business kept the feature.
 *
 * Both are SQL-shaped problems (a partial-index upsert, a batched state sweep),
 * so they are tested against real Postgres.
 */
describe('a business asking for features, and features running out', () => {
  let db: DataSource;
  let features: EnterpriseFeatureRepository;
  let enterpriseId: number;
  let otherId: number;
  /** A real employee: `requested_by_employee_id` carries a foreign key. */
  let employeeId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    features = new EnterpriseFeatureRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    otherId = await seedEnterprise(db, 'Rival', 'rival');
    employeeId = await seedEmployee(enterpriseId, 'asker@acme.test');
  });

  async function seedEmployee(tenant: number, email: string): Promise<number> {
    const identity: { id: string }[] = await db.query(
      `INSERT INTO identities (email, password_hash, first_name)
       VALUES ($1, 'h', 'Asker') RETURNING id`,
      [email],
    );
    const employee: { id: string }[] = await db.query(
      `INSERT INTO enterprise_employees (identity_id, enterprise_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [identity[0]?.id, tenant],
    );
    return Number(employee[0]?.id);
  }

  const setStatus = async (
    tenant: number,
    key: FeatureKey,
    status: EnterpriseFeatureStatus,
    extra: { expiresAt?: Date; declineReason?: string } = {},
  ): Promise<void> => {
    await db.query(
      `INSERT INTO enterprise_features
         (enterprise_id, feature_id, status, expires_at, decline_reason)
       SELECT $1, id, $3, $4, $5 FROM features WHERE key = $2
       ON CONFLICT (enterprise_id, feature_id) WHERE is_deleted = false
       DO UPDATE SET status = $3, expires_at = $4, decline_reason = $5`,
      [tenant, key, status, extra.expiresAt ?? null, extra.declineReason ?? null],
    );
  };

  const statusOf = (tenant: number, key: FeatureKey) => features.currentStatus(tenant, key);

  describe('asking for a feature', () => {
    it('creates a request where there was no row at all', async () => {
      /*
       * The common case, and the one the LEFT JOIN in `listForEnterprise`
       * exists for: a feature never requested has no row, which reads the same
       * as not enabled and is the one somebody might actually want.
       */
      const result = await features.requestAccess({
        enterpriseId,
        featureKey: FeatureKey.CustomerDirectory,
        requestedByEmployeeId: employeeId,
      });

      expect(result?.status).toBe(EnterpriseFeatureStatus.AccessRequested);
      expect(await statusOf(enterpriseId, FeatureKey.CustomerDirectory)).toBe(
        EnterpriseFeatureStatus.AccessRequested,
      );
    });

    it('lets a declined business ask again, and clears the old reason', async () => {
      /*
       * `declined -> access_requested` is the one loop the transition map
       * allows, and the stale reason has to go with it — otherwise the console
       * shows a fresh request alongside last quarter's "not on this plan".
       */
      await setStatus(enterpriseId, FeatureKey.PostInsights, EnterpriseFeatureStatus.Declined, {
        declineReason: 'not on this plan',
      });

      const result = await features.requestAccess({
        enterpriseId,
        featureKey: FeatureKey.PostInsights,
        requestedByEmployeeId: employeeId,
      });

      expect(result?.status).toBe(EnterpriseFeatureStatus.AccessRequested);
      const rows: { decline_reason: string | null }[] = await db.query(
        `SELECT ef.decline_reason FROM enterprise_features ef
           JOIN features f ON f.id = ef.feature_id
          WHERE ef.enterprise_id = $1 AND f.key = $2`,
        [enterpriseId, FeatureKey.PostInsights],
      );
      expect(rows[0]?.decline_reason).toBeNull();
    });

    it('CANNOT move a revoked feature', async () => {
      /*
       * The line the state machine is emphatic about: revoked is withdrawn by
       * us and has no outgoing transitions at all. Enforced by the UPDATE's own
       * WHERE clause rather than only by the service, so a future caller that
       * skips the service cannot route round it.
       */
      await setStatus(enterpriseId, FeatureKey.CommentManagement, EnterpriseFeatureStatus.Revoked);

      const result = await features.requestAccess({
        enterpriseId,
        featureKey: FeatureKey.CommentManagement,
        requestedByEmployeeId: employeeId,
      });

      expect(result).toBeNull();
      expect(await statusOf(enterpriseId, FeatureKey.CommentManagement)).toBe(
        EnterpriseFeatureStatus.Revoked,
      );
    });

    it('CANNOT move an active feature, where a request would mean nothing', async () => {
      await setStatus(enterpriseId, FeatureKey.UnifiedInbox, EnterpriseFeatureStatus.Active);

      expect(
        await features.requestAccess({
          enterpriseId,
          featureKey: FeatureKey.UnifiedInbox,
          requestedByEmployeeId: employeeId,
        }),
      ).toBeNull();
      expect(await statusOf(enterpriseId, FeatureKey.UnifiedInbox)).toBe(
        EnterpriseFeatureStatus.Active,
      );
    });

    it('reports nothing for a key that does not exist', async () => {
      // The row-level guard cannot see this: a business with no row for an
      // unknown key looks identical to one with no row for a real key.
      expect(
        await features.requestAccess({
          enterpriseId,
          featureKey: 'not_a_feature',
          requestedByEmployeeId: employeeId,
        }),
      ).toBeNull();
    });

    it('does not reach into another business', async () => {
      await features.requestAccess({
        enterpriseId,
        featureKey: FeatureKey.CustomerDirectory,
        requestedByEmployeeId: employeeId,
      });

      expect(await statusOf(otherId, FeatureKey.CustomerDirectory)).toBeNull();
    });
  });

  describe('what a business can see', () => {
    it('lists every feature, including ones it has never had', async () => {
      await setStatus(enterpriseId, FeatureKey.UnifiedInbox, EnterpriseFeatureStatus.Active);

      const rows = await features.listForEnterprise(enterpriseId);
      const byKey = new Map(rows.map((row) => [row.key, row]));

      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(byKey.get(FeatureKey.UnifiedInbox)?.status).toBe(EnterpriseFeatureStatus.Active);
      // Never requested: a null status, not a missing row.
      expect(byKey.has(FeatureKey.CustomerDirectory)).toBe(true);
      expect(byKey.get(FeatureKey.CustomerDirectory)?.status).toBeNull();
    });

    it('shows one business nothing of another', async () => {
      await setStatus(otherId, FeatureKey.UnifiedInbox, EnterpriseFeatureStatus.Active);

      const rows = await features.listForEnterprise(enterpriseId);

      expect(rows.every((row) => row.status === null)).toBe(true);
    });
  });

  describe('features running out', () => {
    const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3600_000);
    const hoursAhead = (hours: number): Date => new Date(Date.now() + hours * 3600_000);

    it('expires an active feature whose term has passed', async () => {
      await setStatus(enterpriseId, FeatureKey.PostInsights, EnterpriseFeatureStatus.Active, {
        expiresAt: hoursAgo(1),
      });

      expect(await features.expireDue(100)).toBe(1);
      expect(await statusOf(enterpriseId, FeatureKey.PostInsights)).toBe(
        EnterpriseFeatureStatus.Expired,
      );
    });

    it('leaves one whose term has not', async () => {
      await setStatus(enterpriseId, FeatureKey.PostInsights, EnterpriseFeatureStatus.Active, {
        expiresAt: hoursAhead(1),
      });

      expect(await features.expireDue(100)).toBe(0);
      expect(await statusOf(enterpriseId, FeatureKey.PostInsights)).toBe(
        EnterpriseFeatureStatus.Active,
      );
    });

    it('leaves one with no term at all', async () => {
      // The ordinary case. A feature with no expiry is not a trial.
      await setStatus(enterpriseId, FeatureKey.UnifiedInbox, EnterpriseFeatureStatus.Active);

      expect(await features.expireDue(100)).toBe(0);
    });

    it('touches only ACTIVE rows', async () => {
      /*
       * A disabled or revoked feature with a stale expiry must not be quietly
       * relabelled — `expired` and `revoked` mean different things to whoever
       * reads the console, and the transition map lets a business back out of
       * `expired` but never out of `revoked`.
       */
      await setStatus(enterpriseId, FeatureKey.CommentManagement, EnterpriseFeatureStatus.Revoked, {
        expiresAt: hoursAgo(5),
      });

      expect(await features.expireDue(100)).toBe(0);
      expect(await statusOf(enterpriseId, FeatureKey.CommentManagement)).toBe(
        EnterpriseFeatureStatus.Revoked,
      );
    });

    it('respects the batch limit, so one pass cannot run unbounded', async () => {
      for (const key of [
        FeatureKey.UnifiedInbox,
        FeatureKey.PostInsights,
        FeatureKey.CustomerDirectory,
      ]) {
        await setStatus(enterpriseId, key, EnterpriseFeatureStatus.Active, {
          expiresAt: hoursAgo(2),
        });
      }

      expect(await features.expireDue(2)).toBe(2);
      expect(await features.expireDue(2)).toBe(1);
      expect(await features.expireDue(2)).toBe(0);
    });

    it('sweeps across businesses, because it is not tenant-scoped', async () => {
      // The one query in this repository that is not scoped to a tenant, and it
      // has to be: a nightly sweep runs for everybody or for nobody.
      await setStatus(enterpriseId, FeatureKey.PostInsights, EnterpriseFeatureStatus.Active, {
        expiresAt: hoursAgo(1),
      });
      await setStatus(otherId, FeatureKey.PostInsights, EnterpriseFeatureStatus.Active, {
        expiresAt: hoursAgo(1),
      });

      expect(await features.expireDue(100)).toBe(2);
    });
  });
});
