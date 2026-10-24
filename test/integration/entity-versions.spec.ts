import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { EntityVersionRepository } from '@/database/repositories/entity-version.repository';
import { ActorKind, AuditEntityType } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The configuration history, which answers what the audit log cannot.
 *
 * `audit_logs` records that a program changed and who changed it. `changes`
 * holds whichever fields the call site chose to name, so reconstructing March's
 * configuration means replaying every diff since creation and trusting that
 * none of them left a field out. A reward program decides who receives money,
 * and an award made in March was decided by the program as it stood in March.
 *
 * Each version therefore carries the WHOLE state, not a diff — reading one row
 * answers the question.
 */
describe('entity version history', () => {
  let db: DataSource;
  let versions: EntityVersionRepository;
  let enterpriseId: number;
  let otherId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    versions = new EntityVersionRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    otherId = await seedEnterprise(db, 'Rival', 'rival');
  });

  const append = (tenant: number, entityId: number, snapshot: Record<string, unknown>) =>
    versions.append({
      enterpriseId: tenant,
      entityType: AuditEntityType.RewardProgram,
      entityId,
      snapshot,
      changeSummary: {},
      actorIdentityId: null,
      actorEmployeeId: null,
      actorStaffId: null,
      actorKind: ActorKind.Employee,
      isImpersonated: false,
      correlationId: 'test',
    });

  it('starts at 1 and counts up per entity', async () => {
    expect(await append(enterpriseId, 7, { status: 'draft' })).toBe(1);
    expect(await append(enterpriseId, 7, { status: 'active' })).toBe(2);
    expect(await append(enterpriseId, 7, { status: 'archived' })).toBe(3);
  });

  /**
   * Two entities must not share a counter. With a single sequence, a program's
   * history would be numbered 1, 4, 9 — legible to nobody and impossible to
   * cite.
   */
  it('counts each entity separately', async () => {
    await append(enterpriseId, 7, { status: 'draft' });
    await append(enterpriseId, 7, { status: 'active' });
    expect(await append(enterpriseId, 8, { status: 'draft' })).toBe(1);
  });

  /**
   * The same numeric id in two tenants is an ordinary collision — ids are
   * per-table, not per-tenant — and their histories must not interleave.
   */
  it('counts each tenant separately for the same entity id', async () => {
    await append(enterpriseId, 7, { status: 'draft' });
    await append(enterpriseId, 7, { status: 'active' });
    expect(await append(otherId, 7, { status: 'draft' })).toBe(1);
  });

  it('never returns another tenant’s history', async () => {
    await append(enterpriseId, 7, { status: 'active' });
    await append(otherId, 7, { status: 'archived' });

    const mine = await versions.history(enterpriseId, AuditEntityType.RewardProgram, 7, 50);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.snapshot).toEqual({ status: 'active' });
  });

  /** Newest first, so the current state is the first row rather than the last. */
  it('returns the history newest first', async () => {
    await append(enterpriseId, 7, { status: 'draft' });
    await append(enterpriseId, 7, { status: 'active' });

    const history = await versions.history(enterpriseId, AuditEntityType.RewardProgram, 7, 50);
    expect(history.map((v) => v.version)).toEqual([2, 1]);
  });

  it('bounds the history by the caller’s limit', async () => {
    for (let i = 0; i < 5; i += 1) await append(enterpriseId, 7, { n: i });
    expect(await versions.history(enterpriseId, AuditEntityType.RewardProgram, 7, 2)).toHaveLength(
      2,
    );
  });

  it('reports no history before anything is recorded', async () => {
    expect(await versions.latest(enterpriseId, AuditEntityType.RewardProgram, 7)).toBeNull();
  });

  /**
   * THE WHOLE POINT. A snapshot has to stand alone — reading one row must give
   * the complete state, with no replay of earlier rows required.
   */
  it('stores the whole state, not a diff', async () => {
    await append(enterpriseId, 7, { name: 'Monsoon', status: 'draft', timezone: 'Asia/Kolkata' });
    await append(enterpriseId, 7, { name: 'Monsoon', status: 'active', timezone: 'Asia/Kolkata' });

    const latest = await versions.latest(enterpriseId, AuditEntityType.RewardProgram, 7);
    expect(latest?.snapshot).toEqual({
      name: 'Monsoon',
      status: 'active',
      timezone: 'Asia/Kolkata',
    });
  });

  /** A history that can be edited is not a history. */
  it('refuses an UPDATE', async () => {
    await append(enterpriseId, 7, { status: 'draft' });
    await expect(
      db.query(`UPDATE entity_versions SET snapshot = '{"status":"forged"}'::jsonb`),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a DELETE', async () => {
    await append(enterpriseId, 7, { status: 'draft' });
    await expect(db.query(`DELETE FROM entity_versions`)).rejects.toThrow(/append-only/);
  });

  /**
   * The unique index is the real guarantee behind `MAX(version) + 1`. Without
   * it, two concurrent editors could both write version 2 and one history
   * would silently overwrite the other.
   */
  it('cannot have two rows claim the same version', async () => {
    await append(enterpriseId, 7, { status: 'draft' });
    await expect(
      db.query(
        `INSERT INTO entity_versions
                (enterprise_id, entity_type, entity_id, version, actor_kind)
         VALUES ($1, 'reward_program', 7, 1, 'employee')`,
        [enterpriseId],
      ),
    ).rejects.toThrow(/entity_versions_uniq|duplicate key/i);
  });
});
