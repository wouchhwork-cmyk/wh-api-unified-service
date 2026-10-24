import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { RewardProgramRepository } from '@/database/repositories/reward-program.repository';
import { RewardProgramStatus } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * Archiving a reward program, which is a RETIREMENT rather than a delete.
 *
 * Awards, ledger entries and audit rows all point at a program, and a business
 * has to be able to answer "what was running last March" — so nothing is ever
 * removed. Archiving stops it being used and keeps the record.
 *
 * The guard lives in the UPDATE's WHERE clause rather than in a read followed
 * by a write, which is what these tests are really pinning: two concurrent
 * requests, one archiving and one reactivating, would both pass a
 * check-then-write and the loser would resurrect a retired program.
 */
describe('archiving a reward program', () => {
  let db: DataSource;
  let programs: RewardProgramRepository;
  let enterpriseId: number;
  let otherId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    programs = new RewardProgramRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    otherId = await seedEnterprise(db, 'Rival', 'rival');
  });

  const create = (tenant: number, name: string) =>
    programs.create({
      enterpriseId: tenant,
      name,
      timezone: 'Asia/Kolkata',
      defaultCurrencyCode: 'INR',
      startsAt: null,
      endsAt: null,
    });

  it('moves a program to archived and says so', async () => {
    const program = await create(enterpriseId, 'Monsoon');
    expect(
      await programs.setStatus(enterpriseId, program.refId, RewardProgramStatus.Archived),
    ).toBe('moved');

    const after = await programs.findByRefId(enterpriseId, program.refId);
    expect(after?.status).toBe(RewardProgramStatus.Archived);
  });

  /** THE POINT OF THE FEATURE: it is kept, not deleted. */
  it('keeps the archived program readable', async () => {
    const program = await create(enterpriseId, 'Monsoon');
    await programs.setStatus(enterpriseId, program.refId, RewardProgramStatus.Archived);

    const found = await programs.findByRefId(enterpriseId, program.refId);
    expect(found).not.toBeNull();
    expect(found?.name).toBe('Monsoon');
  });

  /**
   * ONE-WAY. Reusing a retired program would mean its old awards and its new
   * ones share a program, and no report could separate them.
   */
  it('refuses to switch an archived program back on', async () => {
    const program = await create(enterpriseId, 'Monsoon');
    await programs.setStatus(enterpriseId, program.refId, RewardProgramStatus.Archived);

    expect(await programs.setStatus(enterpriseId, program.refId, RewardProgramStatus.Active)).toBe(
      'archived',
    );
    expect(await programs.setStatus(enterpriseId, program.refId, RewardProgramStatus.Paused)).toBe(
      'archived',
    );

    const after = await programs.findByRefId(enterpriseId, program.refId);
    expect(after?.status).toBe(RewardProgramStatus.Archived);
  });

  /** "Archived" and "does not exist" are different answers to different problems. */
  it('tells a missing program apart from an archived one', async () => {
    expect(
      await programs.setStatus(
        enterpriseId,
        '11111111-1111-4111-8111-111111111111',
        RewardProgramStatus.Active,
      ),
    ).toBe('missing');
  });

  it('hides archived programs from the working list and returns them when asked', async () => {
    const live = await create(enterpriseId, 'Live one');
    const retired = await create(enterpriseId, 'Retired one');
    await programs.setStatus(enterpriseId, retired.refId, RewardProgramStatus.Archived);

    const working = await programs.list(enterpriseId, 50);
    expect(working.map((p) => p.name)).toEqual(['Live one']);

    const archived = await programs.list(enterpriseId, 50, RewardProgramStatus.Archived);
    expect(archived.map((p) => p.name)).toEqual(['Retired one']);
    expect(live.refId).not.toBe(retired.refId);
  });

  /** Another tenant cannot archive, or even see, this one. */
  it('cannot be archived across tenants', async () => {
    const program = await create(enterpriseId, 'Monsoon');

    expect(await programs.setStatus(otherId, program.refId, RewardProgramStatus.Archived)).toBe(
      'missing',
    );
    const after = await programs.findByRefId(enterpriseId, program.refId);
    expect(after?.status).toBe(RewardProgramStatus.Draft);
  });
});
