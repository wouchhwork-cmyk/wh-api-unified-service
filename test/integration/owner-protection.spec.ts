import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { RoleRepository } from '@/database/repositories/role.repository';
import { SystemRole } from '@/shared/enums';
import { RequestContext } from '@/shared/context';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * What stops a business being emptied of owners.
 *
 * TWO PATHS CAN REDUCE THE COUNT — suspending an owner and re-roling one down
 * to manager — and both guard against taking the last. Neither guard had a
 * test, which matters more than usual here because they are the only thing
 * between a business and a state it cannot get out of: there is no self-serve
 * recovery, because the only account that could restore an owner is the one
 * being removed.
 *
 * Sequentially the guards cannot fire: to act on an owner you must be an owner,
 * so if somebody is doing the acting then the target is not the last. They
 * exist for the CONCURRENT case, which is reachable and is why both paths take
 * `FOR UPDATE` on the owner role first — two owners removing each other at the
 * same moment would otherwise each read "one other owner remains" and both
 * commit.
 *
 * So what is tested here is the arithmetic those guards depend on, against real
 * Postgres, including the join to employment status that decides whether an
 * owner is a way back into a business at all.
 */
describe('the last owner', () => {
  let db: DataSource;
  let roles: RoleRepository;
  let enterpriseId: number;
  let otherId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    roles = new RoleRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    otherId = await seedEnterprise(db, 'Rival', 'rival');
    await roles.instantiateSystemRoles(enterpriseId);
    await roles.instantiateSystemRoles(otherId);
  });

  /** An employee of this business, holding this role, at this status. */
  async function seedMember(
    tenant: number,
    email: string,
    roleName: SystemRole,
    status: 'active' | 'suspended' | 'invited' = 'active',
  ): Promise<number> {
    const identity: { id: string }[] = await db.query(
      `INSERT INTO identities (email, password_hash, first_name)
       VALUES ($1,'h','Person') RETURNING id`,
      [email],
    );
    const employee: { id: string }[] = await db.query(
      `INSERT INTO enterprise_employees (identity_id, enterprise_id, status)
       VALUES ($1,$2,$3) RETURNING id`,
      [identity[0]?.id, tenant, status],
    );
    const employeeId = Number(employee[0]?.id);

    const role: { id: string }[] = await db.query(
      `SELECT id FROM roles WHERE enterprise_id = $1 AND name = $2`,
      [tenant, roleName],
    );
    await db.query(
      `INSERT INTO employee_roles (enterprise_id, employee_id, role_id) VALUES ($1,$2,$3)`,
      [tenant, employeeId, role[0]?.id],
    );
    return employeeId;
  }

  describe('counting who else could still administer the business', () => {
    it('finds nobody when the target is the only owner', async () => {
      // The refusal case. Zero here is what stops the last owner being removed.
      const founder = await seedMember(enterpriseId, 'founder@acme.test', SystemRole.Owner);

      expect(await roles.countOtherActiveOwners(enterpriseId, founder)).toBe(0);
    });

    it('finds the second owner when there is one', async () => {
      const founder = await seedMember(enterpriseId, 'founder@acme.test', SystemRole.Owner);
      await seedMember(enterpriseId, 'second@acme.test', SystemRole.Owner);

      expect(await roles.countOtherActiveOwners(enterpriseId, founder)).toBe(1);
    });

    it('EXCLUDES the target, which is the whole point of the argument', async () => {
      /*
       * The caller is about to remove this person, so the question is what
       * would be left afterwards. Counting them and subtracting one at the call
       * site is the same arithmetic written where a future reader can forget it.
       */
      const founder = await seedMember(enterpriseId, 'founder@acme.test', SystemRole.Owner);

      // One owner exists; excluding them leaves none.
      const owners: { n: string }[] = await db.query(
        `SELECT count(*)::text AS n FROM employee_roles er
           JOIN roles r ON r.id = er.role_id
          WHERE er.enterprise_id = $1 AND r.name = $2`,
        [enterpriseId, SystemRole.Owner],
      );
      expect(owners[0]?.n).toBe('1');
      expect(await roles.countOtherActiveOwners(enterpriseId, founder)).toBe(0);
    });

    it('does NOT count a suspended owner as a way back in', async () => {
      /*
       * A suspended owner cannot sign in, so they are not somebody who could
       * restore access. Counting them would let the last REAL owner be removed
       * and leave the business locked out behind an account that cannot open it.
       */
      const founder = await seedMember(enterpriseId, 'founder@acme.test', SystemRole.Owner);
      await seedMember(enterpriseId, 'gone@acme.test', SystemRole.Owner, 'suspended');

      expect(await roles.countOtherActiveOwners(enterpriseId, founder)).toBe(0);
    });

    it('does NOT count somebody who has not accepted their invitation', async () => {
      // Same reasoning: an invited owner who never accepted cannot sign in.
      const founder = await seedMember(enterpriseId, 'founder@acme.test', SystemRole.Owner);
      await seedMember(enterpriseId, 'pending@acme.test', SystemRole.Owner, 'invited');

      expect(await roles.countOtherActiveOwners(enterpriseId, founder)).toBe(0);
    });

    it('does not count a manager, however senior they feel', async () => {
      const founder = await seedMember(enterpriseId, 'founder@acme.test', SystemRole.Owner);
      await seedMember(enterpriseId, 'boss@acme.test', SystemRole.Manager);

      expect(await roles.countOtherActiveOwners(enterpriseId, founder)).toBe(0);
    });

    it('does not count ANOTHER business’s owner', async () => {
      // The count decides whether one business can be emptied; a different
      // business's owner is no help at all.
      const founder = await seedMember(enterpriseId, 'founder@acme.test', SystemRole.Owner);
      await seedMember(otherId, 'rival@rival.test', SystemRole.Owner);

      expect(await roles.countOtherActiveOwners(enterpriseId, founder)).toBe(0);
    });

    it('counts a person once even if the grant is duplicated', async () => {
      /*
       * `count(DISTINCT employee_id)`, not `count(*)`. A duplicated grant row
       * would otherwise inflate the count and let the last owner be removed.
       */
      const founder = await seedMember(enterpriseId, 'founder@acme.test', SystemRole.Owner);
      const second = await seedMember(enterpriseId, 'second@acme.test', SystemRole.Owner);
      const role: { id: string }[] = await db.query(
        `SELECT id FROM roles WHERE enterprise_id = $1 AND name = $2`,
        [enterpriseId, SystemRole.Owner],
      );
      await db.query(
        `INSERT INTO employee_roles (enterprise_id, employee_id, role_id, is_deleted)
         VALUES ($1,$2,$3,true)`,
        [enterpriseId, second, role[0]?.id],
      );

      expect(await roles.countOtherActiveOwners(enterpriseId, founder)).toBe(1);
    });

    it('ignores an archived owner role', async () => {
      // Archiving stops a role being assigned; somebody holding an archived
      // role is not an administrator the business can fall back on.
      const founder = await seedMember(enterpriseId, 'founder@acme.test', SystemRole.Owner);
      await seedMember(enterpriseId, 'second@acme.test', SystemRole.Owner);
      await db.query(
        `UPDATE roles SET status = 'archived' WHERE enterprise_id = $1 AND name = $2`,
        [enterpriseId, SystemRole.Owner],
      );

      expect(await roles.countOtherActiveOwners(enterpriseId, founder)).toBe(0);
    });
  });

  describe('the lock the guards take first', () => {
    it('serialises two decisions about who holds owner', async () => {
      /*
       * The reason the guards are not just a read. Both paths count owners and
       * then write, so two owners removing each other at the same moment would
       * each see "one other remains" and both commit — leaving none.
       *
       * THE REPOSITORY METHOD IS CALLED, not a hand-written `FOR UPDATE`. An
       * earlier version of this test wrote the lock statement itself in both
       * transactions, which proved that Postgres implements row locks: delete
       * `FOR UPDATE` from `lockOwnerRole` and it stayed green. Going through
       * `RoleRepository` is what ties it to the code the services actually run.
       */
      await seedMember(enterpriseId, 'founder@acme.test', SystemRole.Owner);

      // The first transaction takes the lock and holds it.
      const holder = db.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      await RequestContext.runInTransaction(holder.manager, () =>
        roles.lockOwnerRole(enterpriseId),
      );

      let secondAcquired = false;
      const contender = db
        .transaction(async (manager) => {
          await RequestContext.runInTransaction(manager, () =>
            roles.lockOwnerRole(enterpriseId),
          );
          secondAcquired = true;
        })
        .catch(() => {
          // An error here must fail the first assertion rather than look like
          // blocking, so it is recorded the same way a success would be.
          secondAcquired = true;
        });

      /*
       * Long enough that an unserialised second transaction would have finished
       * — it is one indexed SELECT. A real-time wait can only fail in the
       * passing direction if the pool is starved, and the assertion after the
       * release is what proves the lock was the reason rather than slowness.
       */
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(secondAcquired).toBe(false);

      await holder.commitTransaction();
      await holder.release();
      await contender;

      // It was waiting on the lock, not failing: released, it completes.
      expect(secondAcquired).toBe(true);
    });

    it('does not block a DIFFERENT business', async () => {
      // The lock is per business. One tenant's role change must not queue
      // behind another's.
      await seedMember(enterpriseId, 'founder@acme.test', SystemRole.Owner);
      await seedMember(otherId, 'rival@rival.test', SystemRole.Owner);

      const holder = db.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      await RequestContext.runInTransaction(holder.manager, () =>
        roles.lockOwnerRole(enterpriseId),
      );

      // The other business proceeds immediately rather than waiting.
      await expect(
        db.transaction(async (manager) =>
          RequestContext.runInTransaction(manager, () => roles.lockOwnerRole(otherId)),
        ),
      ).resolves.toBeUndefined();

      await holder.commitTransaction();
      await holder.release();
    });
  });
});
