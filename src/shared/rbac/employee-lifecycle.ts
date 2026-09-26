/**
 * The three states shared by `enterprise_employees.status` and
 * `staff_members.status`.
 *
 * Two separate enums with identical string values, deliberately: a business's
 * employee and one of Wouchh's own people are different things and must not be
 * interchangeable at a call site. The LIFECYCLE is the same though — created,
 * proven, switched off — and the rule below is the one thing about it worth
 * stating once, so this union is what both enums narrow to here.
 */
export type LifecycleStatus = 'invited' | 'active' | 'suspended';

/**
 * Which employee-status changes the admin endpoint may make.
 *
 * WHY THIS EXISTS AT ALL. `enterprise_employees.status` had no state machine:
 * `setStatus` took a `from` and a `to` and accepted any pair, with the `from`
 * serving only as an optimistic-concurrency check. That is a real hole rather
 * than an untidiness, because one of the transitions it allowed — anything into
 * `active` — manufactures an employment that the person it names never agreed
 * to, and suspending an employment signs that human out of EVERY business they
 * work for.
 *
 * The attack that made it concrete: an owner of business A invites
 * `victim@businessB.test`. Identities are global and shared deliberately (one
 * human, one password, however many jobs), so the invite attaches A to the
 * victim's existing identity without their involvement — they are now an
 * `invited` row in a business they have never heard of. A then flips that row
 * to `active` and to `suspended`, and every session the victim holds is
 * revoked, including the one for business B. Two requests, repeatable, and
 * nothing in the RBAC layer objects because A is acting on a row that really
 * does belong to A.
 *
 * So the rule is not about permissions — the actor genuinely holds
 * `employees.manage` — it is about what a status column is allowed to mean.
 * An employment becomes real when the person accepts the invite from their own
 * mailbox, and nothing an administrator can press may stand in for that.
 */
export type StatusTransitionDenial =
  | { readonly kind: 'already-in-status'; readonly status: LifecycleStatus }
  | { readonly kind: 'acceptance-required' }
  | { readonly kind: 'never-accepted' };

/**
 * @param everAccepted whether this employment ever reached `active` by the
 *   person's own action — `joined_at IS NOT NULL`. Passed in rather than
 *   derived from the status, because a suspended row looks identical whether it
 *   was suspended after years of work or cancelled an hour after an invite was
 *   sent, and only the first may be reinstated.
 */
export function mayChangeStatus(
  from: LifecycleStatus,
  to: LifecycleStatus,
  everAccepted: boolean,
): StatusTransitionDenial | null {
  if (from === to) return { kind: 'already-in-status', status: to };

  if (to === 'active') {
    /*
     * THE TRANSITION THAT CANNOT BE ADMINISTRATIVE. Acceptance is the only path
     * from invited to active: it proves control of the mailbox, which is the
     * entire basis for attaching a business to somebody's identity.
     */
    if (from === 'invited') return { kind: 'acceptance-required' };

    /*
     * And reinstating is closed the same way, or it becomes a laundry: invite →
     * suspend (allowed, it cancels an invite) → reinstate would walk a
     * fabricated row into `active` in two hops and hand back the whole attack.
     */
    if (!everAccepted) return { kind: 'never-accepted' };
  }

  // Into `suspended` from either side is always allowed: it suspends a real
  // employment, or it cancels an invite. Neither invents one.
  return null;
}

export function explainStatusDenial(denial: StatusTransitionDenial): string {
  switch (denial.kind) {
    case 'already-in-status':
      return `already ${denial.status}`;
    case 'acceptance-required':
      return 'this invite has not been accepted yet — the person activates it themselves';
    case 'never-accepted':
      return 'this invite was never accepted, so there is no employment to reinstate — invite them again';
  }
}
