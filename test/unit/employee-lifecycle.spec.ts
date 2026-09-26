import { describe, expect, it } from 'vitest';
import { explainStatusDenial, mayChangeStatus } from '@/shared/rbac';
import { EmployeeStatus } from '@/shared/enums';

const ACCEPTED = true;
const NEVER_ACCEPTED = false;

/**
 * The employee status state machine.
 *
 * These are not tidiness tests. `status` had no state machine at all, and the
 * transition it most obviously wanted — "make this person active" — is the one
 * that lets a business manufacture an employment for somebody who never agreed
 * to it, and then sign that human out of every OTHER business they work for.
 */
describe('changing an employee’s status', () => {
  describe('into active', () => {
    it('refuses an invite the person has not accepted', () => {
      const denial = mayChangeStatus(
        EmployeeStatus.Invited,
        EmployeeStatus.Active,
        NEVER_ACCEPTED,
      );

      expect(denial).toEqual({ kind: 'acceptance-required' });
    });

    it('refuses to reinstate an employment that never existed', () => {
      /*
       * THE LAUNDERING HOP. invited -> suspended is legitimate (it cancels an
       * invite), so without this, two allowed transitions compose into the
       * forbidden one and the whole rule is decorative.
       */
      const denial = mayChangeStatus(
        EmployeeStatus.Suspended,
        EmployeeStatus.Active,
        NEVER_ACCEPTED,
      );

      expect(denial).toEqual({ kind: 'never-accepted' });
    });

    it('allows reinstating somebody who really did work here', () => {
      // The legitimate case this must not break: suspended, then brought back.
      expect(
        mayChangeStatus(EmployeeStatus.Suspended, EmployeeStatus.Active, ACCEPTED),
      ).toBeNull();
    });
  });

  describe('into suspended', () => {
    it('allows suspending an active employee', () => {
      expect(
        mayChangeStatus(EmployeeStatus.Active, EmployeeStatus.Suspended, ACCEPTED),
      ).toBeNull();
    });

    it('allows cancelling an outstanding invite', () => {
      /*
       * Allowed ON PURPOSE, and the service is what makes it harmless: there is
       * no other way to withdraw an invite in this schema, and a cancelled one
       * must not revoke the person's sessions.
       */
      expect(
        mayChangeStatus(EmployeeStatus.Invited, EmployeeStatus.Suspended, NEVER_ACCEPTED),
      ).toBeNull();
    });
  });

  describe('into the status they are already in', () => {
    it('is refused, and says which one', () => {
      // Ahead of every other rule: "already suspended" is a more useful answer
      // than any reason the remaining checks could give.
      expect(mayChangeStatus(EmployeeStatus.Active, EmployeeStatus.Active, ACCEPTED)).toEqual({
        kind: 'already-in-status',
        status: EmployeeStatus.Active,
      });
    });

    it('is refused even where the transition would otherwise be blocked', () => {
      expect(
        mayChangeStatus(EmployeeStatus.Active, EmployeeStatus.Active, NEVER_ACCEPTED),
      ).toEqual({ kind: 'already-in-status', status: EmployeeStatus.Active });
    });
  });

  describe('the explanations', () => {
    it('tells the administrator what to do instead', () => {
      /*
       * These reach a real person who is trying to get somebody working. Both
       * name the action that WOULD work, because "not allowed" alone turns into
       * a support ticket.
       */
      expect(explainStatusDenial({ kind: 'acceptance-required' })).toContain('themselves');
      expect(explainStatusDenial({ kind: 'never-accepted' })).toContain('invite them again');
    });

    it('names the status in the already-in-status case', () => {
      expect(
        explainStatusDenial({ kind: 'already-in-status', status: EmployeeStatus.Suspended }),
      ).toBe('already suspended');
    });

    it('leaks nothing about the person or any other business', () => {
      /*
       * The denial is rendered into an API error that the ATTACKER reads. It
       * must not confirm that the invited address belongs to somebody real, or
       * that they work anywhere else — that would turn a refused request into
       * an enumeration oracle for the platform's whole user base.
       */
      const rendered = [
        explainStatusDenial({ kind: 'acceptance-required' }),
        explainStatusDenial({ kind: 'never-accepted' }),
      ].join(' ');

      expect(rendered).not.toMatch(/business|enterprise|session|elsewhere|already works/i);
    });
  });
});
