import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { PermissionRepository } from '@/database/repositories/permission.repository';
import { StaffMemberRepository } from '@/database/repositories/staff-member.repository';
import { Permission, SystemRole } from '@/shared/enums';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * Staff roles, and what they were worth before they existed.
 *
 * BACKLOG B3, in full. `support` and `ops` were seeded from the first migration
 * and were STRUCTURALLY ungrantable: the only grant table was `employee_roles`,
 * whose `enterprise_id` is NOT NULL behind a composite foreign key routing
 * through it, and a staff template has `enterprise_id IS NULL`. No row could
 * satisfy that, for any enterprise. They were two rows nothing could point at.
 *
 * The visible consequence was that every platform admin got the union of
 * everything those two roles were meant to distinguish — there was no way to
 * give one person read-only reach and another connection-admin reach.
 *
 * Against real Postgres, because the guarantee being added is a composite
 * foreign key and that is not something a mock can refuse.
 */
describe('staff roles', () => {
  let db: DataSource;
  let staff: StaffMemberRepository;
  let permissions: PermissionRepository;
  let enterpriseId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    staff = new StaffMemberRepository(db);
    permissions = new PermissionRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    await db.query(`DELETE FROM staff_roles`);
    await db.query(`DELETE FROM staff_members`);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    // Everything is granted, so a missing permission below is about ROLES and
    // never about the feature gate.
    await db.query(
      `INSERT INTO enterprise_features (enterprise_id, feature_id, status)
       SELECT $1, id, 'active' FROM features WHERE is_deleted = false`,
      [enterpriseId],
    );
  });

  async function seedStaff(email: string, hasAllAccess: boolean): Promise<number> {
    const identity: { id: string }[] = await db.query(
      `INSERT INTO identities (email, password_hash, first_name)
       VALUES ($1, 'h', 'Staff') RETURNING id`,
      [email],
    );
    const row: { id: string }[] = await db.query(
      `INSERT INTO staff_members (identity_id, has_all_enterprise_access, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [identity[0]?.id, hasAllAccess],
    );
    return Number(row[0]?.id);
  }

  const roleId = async (name: string): Promise<number> => {
    const rows: { id: string }[] = await db.query(
      `SELECT id FROM roles WHERE enterprise_id IS NULL AND name = $1`,
      [name],
    );
    return Number(rows[0]?.id);
  };

  describe('the grant that could not previously exist', () => {
    it('gives a scoped staff member exactly what their role grants', async () => {
      const staffId = await seedStaff('ops@wouchh.test', false);
      await staff.replaceStaffRoles({
        staffId,
        roleIds: [await roleId(SystemRole.Ops)],
        grantedByStaffId: null,
      });

      const codes = await permissions.listStaffPermissions(staffId, enterpriseId);

      /*
       * `ops` is connection and sync administration: channels plus the inbox
       * side of it. Crucially it does NOT include reading conversations, which
       * is the distinction that was unrepresentable before.
       */
      expect(codes.sort()).toEqual(
        [
          Permission.ChannelsView,
          Permission.ChannelsConnect,
          Permission.ChannelsManage,
          Permission.ConversationsManage,
        ].sort(),
      );
      expect(codes).not.toContain(Permission.ConversationsView);
    });

    it('gives support a different set from ops, which was the whole point', async () => {
      const supportId = await seedStaff('support@wouchh.test', false);
      const opsId = await seedStaff('ops2@wouchh.test', false);
      await staff.replaceStaffRoles({
        staffId: supportId,
        roleIds: [await roleId(SystemRole.Support)],
        grantedByStaffId: null,
      });
      await staff.replaceStaffRoles({
        staffId: opsId,
        roleIds: [await roleId(SystemRole.Ops)],
        grantedByStaffId: null,
      });

      const support = await permissions.listStaffPermissions(supportId, enterpriseId);
      const ops = await permissions.listStaffPermissions(opsId, enterpriseId);

      expect(support).toContain(Permission.ConversationsView);
      expect(ops).not.toContain(Permission.ConversationsView);
      expect(ops).toContain(Permission.ChannelsConnect);
      expect(support).not.toContain(Permission.ChannelsConnect);
    });

    it('gives a scoped staff member with no roles nothing at all', async () => {
      /*
       * Their state before this existed, and it is still the honest answer for
       * somebody nobody has granted anything: they can sign in and reach
       * nothing. What changed is that it is now possible to grant them
       * something.
       */
      const staffId = await seedStaff('new@wouchh.test', false);

      expect(await permissions.listStaffPermissions(staffId, enterpriseId)).toEqual([]);
    });
  });

  describe('what must not change', () => {
    it('still gives a full platform admin every staff permission', async () => {
      /*
       * The backward-compatibility assertion. `has_all_enterprise_access`
       * remains the superuser switch, so nothing an existing admin can do moves
       * — which is what makes this migration safe to deploy ahead of any
       * grant being made.
       */
      const adminId = await seedStaff('admin@wouchh.test', true);

      const codes = await permissions.listStaffPermissions(adminId, enterpriseId);

      expect(codes).toContain(Permission.ConversationsView);
      expect(codes).toContain(Permission.ChannelsConnect);
      expect(codes).toContain(Permission.FeaturesDecide);
      expect(codes.length).toBeGreaterThan(10);
    });

    it('ignores roles granted to a full admin, rather than narrowing them', async () => {
      // Their permissions come from the flag. A role recorded against them
      // would look like it did something; the service refuses to record one,
      // and this proves that even a directly inserted row changes nothing.
      const adminId = await seedStaff('admin2@wouchh.test', true);
      await db.query(
        `INSERT INTO staff_roles (staff_id, role_id, role_scope) VALUES ($1, $2, 'staff')`,
        [adminId, await roleId(SystemRole.Ops)],
      );

      const codes = await permissions.listStaffPermissions(adminId, enterpriseId);

      expect(codes).toContain(Permission.ConversationsView);
    });

    it('gives a suspended staff member nothing, whatever they hold', async () => {
      /*
       * Fail-closed on the highest-privilege path. The check is re-asked of the
       * ROW on every request, not taken from the token — a staff member whose
       * row was suspended used to keep resolving to the full set until their
       * token expired.
       */
      const staffId = await seedStaff('gone@wouchh.test', false);
      await staff.replaceStaffRoles({
        staffId,
        roleIds: [await roleId(SystemRole.Support)],
        grantedByStaffId: null,
      });
      await db.query(`UPDATE staff_members SET status = 'suspended' WHERE id = $1`, [staffId]);

      expect(await permissions.listStaffPermissions(staffId, enterpriseId)).toEqual([]);
    });

    it('still applies the feature gate to a scoped staff member', async () => {
      // Being one of ours answers "may you reach this business", never "has
      // this business bought the thing you are reaching for".
      const staffId = await seedStaff('gated@wouchh.test', false);
      await staff.replaceStaffRoles({
        staffId,
        roleIds: [await roleId(SystemRole.Support)],
        grantedByStaffId: null,
      });
      await db.query(
        `UPDATE enterprise_features SET status = 'revoked'
          WHERE enterprise_id = $1
            AND feature_id = (SELECT id FROM features WHERE key = 'unified_inbox')`,
        [enterpriseId],
      );

      const codes = await permissions.listStaffPermissions(staffId, enterpriseId);

      expect(codes).not.toContain(Permission.ConversationsView);
      // Not feature-gated at all, so it survives.
      expect(codes).toContain(Permission.ChannelsView);
    });
  });

  describe('the guarantee the database makes', () => {
    it('REFUSES to give a staff member an enterprise-scoped role', async () => {
      /*
       * The composite foreign key, in the opposite direction from the one on
       * `employee_roles`. `staff_roles.role_scope` is pinned to 'staff' by a
       * CHECK and the foreign key routes through it, so a row pairing one of
       * our people with a TENANT role cannot be represented — a platform admin
       * cannot be handed `owner` over somebody's business by any code path,
       * including a bug in a service that has not been written yet.
       */
      const staffId = await seedStaff('sneaky@wouchh.test', false);
      const ownerTemplate: { id: string }[] = await db.query(
        `SELECT id FROM roles WHERE enterprise_id IS NULL AND name = $1`,
        [SystemRole.Owner],
      );

      await expect(
        db.query(
          `INSERT INTO staff_roles (staff_id, role_id, role_scope) VALUES ($1, $2, 'staff')`,
          [staffId, ownerTemplate[0]?.id],
        ),
      ).rejects.toThrow(/staff_roles_role_fk|foreign key/i);
    });

    it('REFUSES a row that claims a non-staff scope', async () => {
      const staffId = await seedStaff('liar@wouchh.test', false);

      await expect(
        db.query(
          `INSERT INTO staff_roles (staff_id, role_id, role_scope) VALUES ($1, $2, 'enterprise')`,
          [staffId, await roleId(SystemRole.Ops)],
        ),
      ).rejects.toThrow(/staff_roles_scope_chk|check constraint/i);
    });

    it('REFUSES a duplicate grant', async () => {
      const staffId = await seedStaff('twice@wouchh.test', false);
      const ops = await roleId(SystemRole.Ops);
      await db.query(
        `INSERT INTO staff_roles (staff_id, role_id, role_scope) VALUES ($1, $2, 'staff')`,
        [staffId, ops],
      );

      await expect(
        db.query(
          `INSERT INTO staff_roles (staff_id, role_id, role_scope) VALUES ($1, $2, 'staff')`,
          [staffId, ops],
        ),
      ).rejects.toThrow(/staff_roles_uniq|duplicate key/i);
    });
  });

  describe('replacing what somebody holds', () => {
    it('replaces rather than adds', async () => {
      const staffId = await seedStaff('moved@wouchh.test', false);
      await staff.replaceStaffRoles({
        staffId,
        roleIds: [await roleId(SystemRole.Support)],
        grantedByStaffId: null,
      });
      await staff.replaceStaffRoles({
        staffId,
        roleIds: [await roleId(SystemRole.Ops)],
        grantedByStaffId: null,
      });

      const codes = await permissions.listStaffPermissions(staffId, enterpriseId);
      expect(codes).toContain(Permission.ChannelsConnect);
      expect(codes).not.toContain(Permission.ConversationsView);
    });

    it('accepts an empty set, which is a real state', async () => {
      // Unlike an employee, a staff member with no roles is meaningful:
      // somebody who still works here and currently reaches nothing.
      const staffId = await seedStaff('paused@wouchh.test', false);
      await staff.replaceStaffRoles({
        staffId,
        roleIds: [await roleId(SystemRole.Ops)],
        grantedByStaffId: null,
      });

      await staff.replaceStaffRoles({ staffId, roleIds: [], grantedByStaffId: null });

      expect(await permissions.listStaffPermissions(staffId, enterpriseId)).toEqual([]);
    });
  });
});
