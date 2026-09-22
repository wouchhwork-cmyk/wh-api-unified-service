import { describe, expect, it } from 'vitest';
import {
  explainDenial,
  mayAssignRole,
  mayDefineRole,
  mayModifyEmployee,
  maySeeEmployee,
  type ActorAuthority,
} from '@/shared/rbac';
import { highestRoleLevel, MAX_CREATABLE_ROLE_LEVEL, ROLE_LEVEL, SystemRole } from '@/shared/enums';

/**
 * Who may hand out what.
 *
 * THESE ARE THE ESCALATION RULES, so the tests are written as attacks rather
 * than as coverage. Before this module existed the entire "who may grant what"
 * logic was one string comparison against the name `owner` — which stopped a
 * manager taking the business outright and stopped nothing else. A manager
 * could mint another manager, suspend the owner, or (once role editing landed)
 * define a role carrying permissions they did not hold and grant it.
 *
 * Every case below is one of those routes, closed.
 */
describe('role authority', () => {
  const actor = (over: Partial<ActorAuthority> = {}): ActorAuthority => ({
    employeeId: 1,
    level: ROLE_LEVEL.Manager,
    roleNames: [SystemRole.Manager],
    permissionCodes: new Set(['conversations.view', 'conversations.reply', 'employees.invite']),
    ...over,
  });

  const owner = (): ActorAuthority =>
    actor({
      employeeId: 9,
      level: ROLE_LEVEL.Owner,
      roleNames: [SystemRole.Owner],
      permissionCodes: new Set([
        'conversations.view',
        'conversations.reply',
        'employees.invite',
        'enterprise.manage',
      ]),
    });

  const role = (
    level: number,
    name = 'custom',
    isSystem = false,
    permissionCodes: string[] = [],
  ) => ({ name, level, isSystem, permissionCodes });

  describe('assigning a role to somebody', () => {
    it('lets a manager assign a role below them', () => {
      expect(mayAssignRole(actor(), role(ROLE_LEVEL.Agent))).toBeNull();
    });

    it('REFUSES a manager assigning the manager role', () => {
      /*
       * The attack this whole mechanism exists for, and the one the old
       * name-only check missed entirely: invite an address you control into
       * your own level, accept it, and now there are two of you — with nobody
       * above able to tell the difference.
       */
      expect(mayAssignRole(actor(), role(ROLE_LEVEL.Manager))).toBe('role_not_below_actor');
    });

    it('REFUSES a manager assigning anything above them', () => {
      expect(mayAssignRole(actor(), role(ROLE_LEVEL.Owner - 1))).toBe('role_not_below_actor');
    });

    it('REFUSES a manager assigning the owner role', () => {
      expect(mayAssignRole(actor(), role(ROLE_LEVEL.Owner, SystemRole.Owner))).toBe(
        'owner_grants_owner',
      );
    });

    it('lets an owner assign the owner role', () => {
      expect(mayAssignRole(owner(), role(ROLE_LEVEL.Owner, SystemRole.Owner))).toBeNull();
    });

    it('REFUSES a role that reached owner LEVEL under another name', () => {
      /*
       * Belt and braces. `mayDefineRole` already refuses to create anything at
       * 100, but if such a row ever existed — a bad migration, a direct insert,
       * a future import path — the name check alone would wave it through
       * because it is not called "owner".
       */
      expect(mayAssignRole(actor(), role(ROLE_LEVEL.Owner, 'super-admin'))).toBe(
        'owner_grants_owner',
      );
    });

    it('REFUSES a role carrying more than the assigner holds', () => {
      /*
       * FOUND IN REVIEW, AND IT WAS REAL. The subset rule defended the CREATE
       * half of the threat and not the GRANT half — it assumed the only way
       * such a role can exist is for the actor to have made it.
       *
       * An owner can make one legitimately, and delegating billing without
       * handing over the business is the most natural reason to create a custom
       * role at all. So: owner creates "Billing clerk" at level 30 carrying
       * `enterprise.manage`; a manager holds `employees.invite`, does not hold
       * `enterprise.manage`, and the level check waves it through because
       * 30 < 70. The manager invites an address they control into that role,
       * accepts from their own mailbox, and holds through a second session the
       * one permission the whole ladder exists to withhold from them.
       *
       * Level dominance does NOT imply permission dominance. It happens to on
       * the stock seed and stops the moment a business uses custom roles.
       */
      const billingClerk = role(30, 'Billing clerk', false, ['enterprise.manage']);

      expect(mayAssignRole(actor(), billingClerk)).toBe('permissions_exceed_actor');
      // The owner, who does hold it, may still hand it out.
      expect(mayAssignRole(owner(), billingClerk)).toBeNull();
    });

    it('allows a role whose permissions the assigner does hold', () => {
      expect(
        mayAssignRole(actor(), role(30, 'Helper', false, ['conversations.view'])),
      ).toBeNull();
    });

    it('REFUSES somebody holding no roles at all', () => {
      // An invited employee who has not been granted anything must not be able
      // to bootstrap themselves.
      expect(mayAssignRole(actor({ level: null, roleNames: [] }), role(ROLE_LEVEL.Viewer))).toBe(
        'actor_has_no_authority',
      );
    });

    it('takes the HIGHEST of several roles as the actor authority', () => {
      /*
       * Roles are additive, so holding agent as well as manager cannot make
       * somebody less senior.
       *
       * This calls `highestRoleLevel` — the real rule — rather than computing
       * `Math.max` in the test and handing the answer in. It used to do the
       * latter, which meant changing the production rule to `Math.min` left the
       * test green: it was asserting that Math.max is Math.max.
       */
      const both = actor({
        level: highestRoleLevel([ROLE_LEVEL.Agent, ROLE_LEVEL.Manager]),
        roleNames: [SystemRole.Manager, SystemRole.Agent],
      });

      expect(both.level).toBe(ROLE_LEVEL.Manager);
      expect(mayAssignRole(both, role(ROLE_LEVEL.Agent))).toBeNull();
    });
  });

  describe('how several roles combine into one authority', () => {
    /*
     * `highestRoleLevel` had NO test, and it is the one rule in the module
     * whose docstring names its own attack: "taking the minimum would let an
     * attacker de-escalate a rival by ADDING a junior role to them."
     */
    it('is the highest, so an extra junior role cannot demote somebody', () => {
      expect(highestRoleLevel([ROLE_LEVEL.Manager, ROLE_LEVEL.Viewer])).toBe(ROLE_LEVEL.Manager);
      expect(highestRoleLevel([ROLE_LEVEL.Viewer, ROLE_LEVEL.Manager])).toBe(ROLE_LEVEL.Manager);
    });

    it('is NULL for somebody holding nothing, not zero', () => {
      /*
       * Zero is a real level that compares; "no roles yet" is not a position on
       * the ladder. Treating the two as the same is how an invited-but-ungranted
       * employee ends up able to act.
       */
      expect(highestRoleLevel([])).toBeNull();
    });

    it('copes with a single role and with duplicates', () => {
      expect(highestRoleLevel([ROLE_LEVEL.Agent])).toBe(ROLE_LEVEL.Agent);
      expect(highestRoleLevel([ROLE_LEVEL.Agent, ROLE_LEVEL.Agent])).toBe(ROLE_LEVEL.Agent);
    });

    it('keeps a level of zero rather than discarding it as falsy', () => {
      // 0 is the bottom of the ladder and a legitimate level — a `||` in this
      // function would turn it into null and make its holder unreachable.
      expect(highestRoleLevel([0])).toBe(0);
    });
  });

  describe('defining a role', () => {
    it('lets a manager define a role below them, within their own permissions', () => {
      expect(
        mayDefineRole(actor(), {
          level: ROLE_LEVEL.Agent,
          permissionCodes: ['conversations.view', 'conversations.reply'],
        }),
      ).toBeNull();
    });

    it('REFUSES a role carrying a permission the actor does not hold', () => {
      /*
       * THE SUBTLE ONE, and the reason role editing could not ship before this
       * module. The level rule alone is satisfied — the role is below the
       * manager — but it would carry `enterprise.manage`, which the manager
       * does not have. Grant it to a colleague and that colleague can do what
       * the manager cannot, which is escalation by proxy.
       */
      expect(
        mayDefineRole(actor(), {
          level: ROLE_LEVEL.Agent,
          permissionCodes: ['conversations.view', 'enterprise.manage'],
        }),
      ).toBe('permissions_exceed_actor');
    });

    it('lets an owner define a role carrying everything they hold', () => {
      expect(
        mayDefineRole(owner(), {
          level: ROLE_LEVEL.Manager,
          permissionCodes: ['enterprise.manage'],
        }),
      ).toBeNull();
    });

    it('REFUSES a role at or above the actor level', () => {
      expect(mayDefineRole(actor(), { level: ROLE_LEVEL.Manager, permissionCodes: [] })).toBe(
        'role_not_below_actor',
      );
    });

    it('REFUSES anything at the owner level, even from an owner', () => {
      /*
       * There is exactly one top of the ladder, and it comes from the seed. A
       * second owner-level role would be a way around every owner rule that
       * checks the NAME, and a business that created one could not undo it.
       */
      expect(mayDefineRole(owner(), { level: ROLE_LEVEL.Owner, permissionCodes: [] })).toBe(
        'owner_level_reserved',
      );
    });

    it('allows exactly up to the highest creatable level', () => {
      expect(
        mayDefineRole(owner(), { level: MAX_CREATABLE_ROLE_LEVEL, permissionCodes: [] }),
      ).toBeNull();
      expect(MAX_CREATABLE_ROLE_LEVEL).toBeLessThan(ROLE_LEVEL.Owner);
    });

    it('REFUSES editing a seeded role', () => {
      /*
       * Otherwise the whole ladder is editable: change what `agent` means and
       * every agent in the business changes with it, including ones granted by
       * somebody more senior.
       */
      expect(
        mayDefineRole(owner(), {
          level: ROLE_LEVEL.Agent,
          permissionCodes: [],
          isSystem: true,
        }),
      ).toBe('system_role_immutable');
    });

    it('REFUSES somebody holding no roles', () => {
      expect(
        mayDefineRole(actor({ level: null, roleNames: [] }), {
          level: ROLE_LEVEL.Viewer,
          permissionCodes: [],
        }),
      ).toBe('actor_has_no_authority');
    });

    it('accepts an empty permission set', () => {
      // A role that grants nothing is useless but not dangerous, and refusing
      // it would block the obvious way to build one up a field at a time.
      expect(mayDefineRole(actor(), { level: ROLE_LEVEL.Viewer, permissionCodes: [] })).toBeNull();
    });
  });

  describe('acting on another employee', () => {
    it('lets a manager act on an agent', () => {
      expect(mayModifyEmployee(actor(), { employeeId: 2, level: ROLE_LEVEL.Agent })).toBeNull();
    });

    it('REFUSES a manager suspending the owner', () => {
      /*
       * A real hole before this: `employees.manage` is held by the manager
       * role and the only check was the self one. Suspending somebody revokes
       * every session that identity holds ACROSS EVERY BUSINESS, so this was
       * also a way to hit somebody outside this tenant.
       */
      expect(mayModifyEmployee(actor(), { employeeId: 2, level: ROLE_LEVEL.Owner })).toBe(
        'target_not_below_actor',
      );
    });

    it('REFUSES a manager acting on another manager', () => {
      // Equals must not be able to remove each other; that turns a
      // disagreement into a race won by whoever clicks first.
      expect(mayModifyEmployee(actor(), { employeeId: 2, level: ROLE_LEVEL.Manager })).toBe(
        'target_not_below_actor',
      );
    });

    it('REFUSES acting on yourself, and says so specifically', () => {
      /*
       * Checked before the level rule, and reported differently. "You do not
       * outrank them" is also true of yourself and would be a baffling way to
       * be told you cannot suspend your own account.
       */
      expect(mayModifyEmployee(actor(), { employeeId: 1, level: ROLE_LEVEL.Manager })).toBe(
        'cannot_act_on_self',
      );
    });

    it('still refuses self even when the actor holds no roles', () => {
      expect(
        mayModifyEmployee(actor({ level: null, roleNames: [] }), { employeeId: 1, level: null }),
      ).toBe('cannot_act_on_self');
    });

    it('lets one owner act on another, because nobody is above them', () => {
      /*
       * THE ONE PLACE EQUALS MAY ACT ON EACH OTHER, and it was a real gap: the
       * strict rule made an owner unmodifiable BY ANYONE, so a business whose
       * founder had left was stuck with a live account it could never close.
       *
       * That is a certainty. The rogue-co-owner case it trades against is a
       * possibility between two people who already hold total control and could
       * ruin the business a dozen other ways. The last active owner is
       * protected separately, in the service, so this cannot empty a business
       * of owners.
       */
      const owner = actor({ employeeId: 9, level: ROLE_LEVEL.Owner, roleNames: [SystemRole.Owner] });

      expect(mayModifyEmployee(owner, { employeeId: 2, level: ROLE_LEVEL.Owner })).toBeNull();
    });

    it('still refuses an owner acting on THEMSELVES', () => {
      // The peer rule must not become a self rule: an owner locking themselves
      // out has nobody above to undo it either.
      const owner = actor({ employeeId: 9, level: ROLE_LEVEL.Owner, roleNames: [SystemRole.Owner] });

      expect(mayModifyEmployee(owner, { employeeId: 9, level: ROLE_LEVEL.Owner })).toBe(
        'cannot_act_on_self',
      );
    });

    it('does not extend the peer rule to any other level', () => {
      // Managers are still strict. The exception is justified only by there
      // being nobody above; at 70 there is.
      expect(mayModifyEmployee(actor(), { employeeId: 2, level: ROLE_LEVEL.Manager })).toBe(
        'target_not_below_actor',
      );
    });

    it('lets anyone with authority act on somebody who holds no roles', () => {
      // The half-finished invite. Treating "no level" as unreachable would make
      // it impossible to clean up.
      expect(mayModifyEmployee(actor(), { employeeId: 2, level: null })).toBeNull();
    });
  });

  describe('seeing another employee', () => {
    it('lets an agent see other agents', () => {
      // Inclusive, unlike acting: a team that cannot see its own peers cannot
      // hand work over.
      expect(maySeeEmployee(ROLE_LEVEL.Agent, ROLE_LEVEL.Agent)).toBe(true);
    });

    it('hides managers from agents', () => {
      expect(maySeeEmployee(ROLE_LEVEL.Agent, ROLE_LEVEL.Manager)).toBe(false);
    });

    it('hides the owner from a manager', () => {
      expect(maySeeEmployee(ROLE_LEVEL.Manager, ROLE_LEVEL.Owner)).toBe(false);
    });

    it('shows everybody to the owner', () => {
      for (const level of Object.values(ROLE_LEVEL)) {
        expect(maySeeEmployee(ROLE_LEVEL.Owner, level)).toBe(true);
      }
    });

    it('shows nobody to somebody holding no roles', () => {
      expect(maySeeEmployee(null, ROLE_LEVEL.Viewer)).toBe(false);
    });

    it('shows an unroled employee to anyone with authority', () => {
      expect(maySeeEmployee(ROLE_LEVEL.Viewer, null)).toBe(true);
    });

    it('is strictly more permissive than acting, at every level', () => {
      /*
       * The invariant that keeps the three rules coherent: anything you may ACT
       * on, you may also SEE. A configuration where the reverse held would let
       * somebody suspend a person their own list never showed them.
       */
      const levels = [null, 0, ROLE_LEVEL.Viewer, ROLE_LEVEL.Agent, ROLE_LEVEL.Manager, ROLE_LEVEL.Owner];
      for (const actorLevel of levels) {
        for (const targetLevel of levels) {
          const canAct =
            mayModifyEmployee(actor({ level: actorLevel }), {
              employeeId: 2,
              level: targetLevel,
            }) === null;
          if (canAct) expect(maySeeEmployee(actorLevel, targetLevel)).toBe(true);
        }
      }
    });
  });

  describe('explaining a refusal', () => {
    it('has a sentence for every reason', () => {
      // A denial reason with no explanation reaches somebody as a blank, and
      // the switch is exhaustive so a new reason without one will not compile.
      const reasons = [
        'actor_has_no_authority',
        'role_not_below_actor',
        'owner_grants_owner',
        'permissions_exceed_actor',
        'target_not_below_actor',
        'cannot_act_on_self',
        'system_role_immutable',
        'owner_level_reserved',
      ] as const;

      for (const reason of reasons) {
        expect(explainDenial(reason).length).toBeGreaterThan(10);
      }
    });

    it('never names an internal level number', () => {
      // These reach an end user. "You need level 70" means nothing to somebody
      // who has never seen the ladder.
      const reasons = ['role_not_below_actor', 'owner_level_reserved'] as const;
      for (const reason of reasons) {
        expect(explainDenial(reason)).not.toMatch(/\d/);
      }
    });
  });
});
