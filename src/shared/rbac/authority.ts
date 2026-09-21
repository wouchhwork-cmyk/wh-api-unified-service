import { MAX_CREATABLE_ROLE_LEVEL, ROLE_LEVEL, SystemRole } from '@/shared/enums';

/**
 * Who may hand out what.
 *
 * PURE, AND DELIBERATELY SO. These are the rules that stand between a manager
 * and full control of a business, and they are the kind of rule that is easy to
 * write, hard to review and impossible to notice failing. Keeping them free of
 * database access and request context means every branch can be tested directly
 * rather than through four layers of setup — and an escalation rule that is
 * awkward to test is one that ends up under-tested.
 *
 * WHY A REASON RATHER THAN A BOOLEAN. A denial that says only "no" produces
 * either a useless error message or a second, drifting copy of the logic in the
 * caller to explain itself. It also makes the tests assert WHICH rule fired,
 * so a test cannot keep passing because a different rule happened to deny.
 *
 * THE THREE COMPARISONS, and their differences are the design:
 *
 *   see an employee      target <= actor   an agent sees agents
 *   assign a role        role   <  actor   a manager cannot mint a manager
 *   modify an employee   target <  actor   a manager cannot suspend an owner
 *
 * Reading is inclusive because a team that cannot see its own peers cannot
 * work. Acting is exclusive because equals must not be able to remove each
 * other, which is how two managers turn a disagreement into a race.
 */

/** Why an action was refused. Every value is a rule, not a message. */
export type AuthorityDenial =
  /** The actor holds no roles at all, so they outrank nothing. */
  | 'actor_has_no_authority'
  /** The role is at or above the actor's own level. */
  | 'role_not_below_actor'
  /** Only an owner may create another owner. */
  | 'owner_grants_owner'
  /** The role would carry permissions the actor does not hold. */
  | 'permissions_exceed_actor'
  /** The target employee is at or above the actor's own level. */
  | 'target_not_below_actor'
  /** Nobody acts on themselves. */
  | 'cannot_act_on_self'
  /** Seeded roles are grantable but never editable. */
  | 'system_role_immutable'
  /** No API path creates a role at the owner's level. */
  | 'owner_level_reserved';

/** What the acting employee brings to the decision. */
export interface ActorAuthority {
  readonly employeeId: number;
  /** Highest level among the roles they hold. NULL when they hold none. */
  readonly level: number | null;
  readonly roleNames: readonly string[];
  /**
   * The codes their roles grant, NOT passed through the feature gate.
   * See rbac-plan.md §3.2 for why.
   */
  readonly permissionCodes: ReadonlySet<string>;
}

/** The role being granted, created or edited. */
export interface TargetRole {
  readonly name: string;
  readonly level: number;
  readonly isSystem: boolean;
}

/** The employee being acted on. */
export interface TargetEmployee {
  readonly employeeId: number;
  /** Highest level among their roles. NULL when they hold none. */
  readonly level: number | null;
}

function isOwner(actor: ActorAuthority): boolean {
  return actor.roleNames.includes(SystemRole.Owner);
}

/**
 * May this actor give somebody this role?
 *
 * The owner rule is kept as a NAME check alongside the level check rather than
 * folded into it. They are two different statements — "is at the top of the
 * ladder" and "is numerically above" — and collapsing them would mean a
 * business that levelled a custom role at 100 could hand out something
 * equivalent to owner. The reserved level below stops that being creatable at
 * all, so this is belt and braces on the one rule whose failure is total.
 */
export function mayAssignRole(actor: ActorAuthority, role: TargetRole): AuthorityDenial | null {
  if (actor.level === null) return 'actor_has_no_authority';

  if (role.name === (SystemRole.Owner as string) || role.level >= ROLE_LEVEL.Owner) {
    return isOwner(actor) ? null : 'owner_grants_owner';
  }

  // STRICTLY below. A manager handing out the manager role is exactly the
  // escalation this whole mechanism exists to stop: invite an address you
  // control, accept it, and now there are two of you.
  if (role.level >= actor.level) return 'role_not_below_actor';

  return null;
}

/**
 * May this actor define a role at this level, carrying these permissions?
 *
 * Both halves are needed and neither implies the other. Without the level
 * check a manager could create a role above themselves and grant it to a
 * colleague; without the subset check they could create a role BELOW
 * themselves that nonetheless carries `enterprise.manage`, grant it, and have
 * that person do what the manager could not. The second is the subtler one and
 * is the reason role editing could not ship before this module existed.
 */
export function mayDefineRole(
  actor: ActorAuthority,
  role: { level: number; permissionCodes: readonly string[]; isSystem?: boolean },
): AuthorityDenial | null {
  if (actor.level === null) return 'actor_has_no_authority';
  if (role.isSystem === true) return 'system_role_immutable';

  // Nothing creates a second owner-level role. Enforced here as well as by the
  // contract's range, because a reserved level is only reserved if every path
  // that writes one agrees.
  if (role.level > MAX_CREATABLE_ROLE_LEVEL) return 'owner_level_reserved';
  if (role.level >= actor.level) return 'role_not_below_actor';

  for (const code of role.permissionCodes) {
    if (!actor.permissionCodes.has(code)) return 'permissions_exceed_actor';
  }

  return null;
}

/**
 * May this actor suspend, reinstate or re-role this employee?
 *
 * Self is checked FIRST, and separately, because "you cannot do this to
 * yourself" is a different and more useful thing to be told than "you do not
 * outrank them" — which is also true of yourself, and would be a confusing way
 * to say it.
 */
export function mayModifyEmployee(
  actor: ActorAuthority,
  target: TargetEmployee,
): AuthorityDenial | null {
  if (actor.employeeId === target.employeeId) return 'cannot_act_on_self';
  if (actor.level === null) return 'actor_has_no_authority';

  /*
   * An employee with NO roles is modifiable by anyone with authority. That is
   * the invited-but-not-yet-granted case, and the alternative — treating "no
   * level" as unreachable — would make a half-finished invite impossible to
   * clean up.
   */
  if (target.level === null) return null;

  if (target.level >= actor.level) return 'target_not_below_actor';
  return null;
}

/**
 * May this actor see this employee at all?
 *
 * Inclusive, unlike the two above: an agent sees other agents. Somebody who
 * cannot see their own peers cannot pick up their work or hand it over.
 *
 * An actor with no roles sees nobody — not even themselves through this path.
 * Their own record reaches them through `/auth/me`, which is not a listing and
 * is not governed by this.
 */
export function maySeeEmployee(actorLevel: number | null, targetLevel: number | null): boolean {
  if (actorLevel === null) return false;
  // An employee with no roles is visible to anyone with any authority; they are
  // the ones most likely to need attention.
  if (targetLevel === null) return true;
  return targetLevel <= actorLevel;
}

/** A denial turned into something a person can act on. */
export function explainDenial(denial: AuthorityDenial): string {
  switch (denial) {
    case 'actor_has_no_authority':
      return 'you hold no role that carries this authority';
    case 'role_not_below_actor':
      return 'you can only assign roles below your own level';
    case 'owner_grants_owner':
      return 'only an owner can grant the owner role';
    case 'permissions_exceed_actor':
      return 'a role cannot be given permissions you do not hold yourself';
    case 'target_not_below_actor':
      return 'you can only act on people below your own level';
    case 'cannot_act_on_self':
      return 'you cannot do this to your own account';
    case 'system_role_immutable':
      return 'built-in roles cannot be edited; create your own role instead';
    case 'owner_level_reserved':
      return 'the owner level is reserved and cannot be assigned to a new role';
  }
}
