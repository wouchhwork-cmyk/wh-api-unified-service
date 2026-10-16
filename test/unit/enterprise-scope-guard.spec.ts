import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { EnterpriseScopeGuard } from '@/shared/guards/enterprise-scope.guard';
import { EnterpriseActiveGuard } from '@/shared/guards/enterprise-active.guard';
import type { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { RequestContext } from '@/shared/context';
import {
  IS_PUBLIC_KEY,
  REQUIRED_ANY_PERMISSION_KEY,
  REQUIRED_PERMISSIONS_KEY,
} from '@/shared/decorators';
import { ActorKind, EnterpriseStatus } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';

/**
 * Gate 1: does the token carry an enterprise?
 *
 * WRITTEN BECAUSE THE GATE WAS SKIPPING HALF THE ROUTES. It read only
 * `@RequirePermission`, so every `@RequireAnyPermission` route — the whole
 * inbox controller, eleven of them — passed straight through without a scope
 * check.
 *
 * Nothing was exploitable: `@CurrentScopedActor` re-checks the enterprise, and
 * an actor with no scope resolves no permissions, so gate 2 refused them
 * anyway. That is exactly why it went unnoticed, and exactly why it is worth a
 * test: two layers agreeing by accident is not defence in depth, it is one
 * layer and a coincidence, and the next route written that way inherits the
 * gap silently.
 */
describe('the enterprise scope guard', () => {
  const reflectorFor = (metadata: Record<string, unknown>): Reflector =>
    ({ getAllAndOverride: (key: string) => metadata[key] }) as unknown as Reflector;

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;

  /** Runs the guard for an actor with this scope against this route metadata. */
  const run = (
    actor: { enterpriseId: number | null; employeeId: number | null; actorKind?: ActorKind },
    metadata: Record<string, unknown>,
  ): boolean =>
    RequestContext.run({ correlationId: 'test' }, () => {
      RequestContext.setActor({
        correlationId: 'test',
        identityId: 1,
        enterpriseId: actor.enterpriseId,
        employeeId: actor.employeeId,
        staffId: null,
        actorKind: actor.actorKind ?? ActorKind.Employee,
        isImpersonated: false,
        permissions: new Set<string>(),
      });
      return new EnterpriseScopeGuard(reflectorFor(metadata)).canActivate(context);
    });

  const scoped = { enterpriseId: 7, employeeId: 3 };
  const unscoped = { enterpriseId: null, employeeId: null };

  describe('a route declaring ALL of some permissions', () => {
    it('refuses an actor with no business chosen', () => {
      expect(() => run(unscoped, { [REQUIRED_PERMISSIONS_KEY]: ['inbox.view'] })).toThrow(
        AppException,
      );
    });

    it('admits one that has chosen a business', () => {
      expect(run(scoped, { [REQUIRED_PERMISSIONS_KEY]: ['inbox.view'] })).toBe(true);
    });
  });

  describe('a route declaring ANY of some permissions', () => {
    it('refuses an actor with no business chosen', () => {
      /*
       * THE REGRESSION THIS FILE EXISTS FOR. Before the fix this returned true:
       * the guard never looked at REQUIRED_ANY_PERMISSION_KEY, so a route
       * declaring its permissions that way was treated as identity-scoped.
       */
      let thrown: unknown;
      try {
        run(unscoped, { [REQUIRED_ANY_PERMISSION_KEY]: ['conversations.view', 'mentions.view'] });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppException);
      expect((thrown as AppException).code).toBe(ErrorCode.AuthEnterpriseNotSelected);
    });

    it('admits one that has chosen a business', () => {
      expect(run(scoped, { [REQUIRED_ANY_PERMISSION_KEY]: ['conversations.view'] })).toBe(true);
    });

    it('still refuses an employee with no employment', () => {
      // Scope alone is not enough: a token can name a business the person no
      // longer works at.
      expect(() =>
        run(
          { enterpriseId: 7, employeeId: null },
          { [REQUIRED_ANY_PERMISSION_KEY]: ['conversations.view'] },
        ),
      ).toThrow(AppException);
    });

    it('lets staff through without an employment, which is how staff reach works', () => {
      expect(
        run(
          { enterpriseId: 7, employeeId: null, actorKind: ActorKind.Staff },
          { [REQUIRED_ANY_PERMISSION_KEY]: ['conversations.view'] },
        ),
      ).toBe(true);
    });
  });

  describe('routes that are not tenant-scoped', () => {
    it('lets a public route through', () => {
      expect(run(unscoped, { [IS_PUBLIC_KEY]: true })).toBe(true);
    });

    it('lets a route declaring no permission through', () => {
      // /auth/me and enterprise switching: identity-scoped by design.
      expect(run(unscoped, {})).toBe(true);
    });

    it('treats an EMPTY permission list as no declaration', () => {
      expect(run(unscoped, { [REQUIRED_ANY_PERMISSION_KEY]: [] })).toBe(true);
    });
  });
});

/**
 * Gate 1b: is the business still allowed to be here?
 *
 * THE SAME BLIND SPOT, AND THIS ONE WAS EXPLOITABLE. Both guards asked "does
 * this route declare a permission?" and both read only `@RequirePermission`.
 * For the scope guard that was survivable — an actor with no scope resolves no
 * permissions, so gate 2 refused them anyway. Nothing downstream checks that a
 * business is still ACTIVE, so a suspended or not-yet-approved enterprise kept
 * full read and reply access to its whole inbox.
 *
 * Both guards now ask one shared function, which is the point: a question
 * asked in two places is eventually answered differently in each, and the
 * second answer is the one nobody tests.
 */
describe('the active enterprise guard', () => {
  const reflectorFor = (metadata: Record<string, unknown>): Reflector =>
    ({ getAllAndOverride: (key: string) => metadata[key] }) as unknown as Reflector;

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;

  const enterprisesAt = (status: EnterpriseStatus | null): EnterpriseRepository =>
    ({ statusById: () => Promise.resolve(status) }) as unknown as EnterpriseRepository;

  const run = (
    status: EnterpriseStatus | null,
    metadata: Record<string, unknown>,
    actorKind: ActorKind = ActorKind.Employee,
  ): Promise<boolean> =>
    RequestContext.run({ correlationId: 'test' }, () => {
      RequestContext.setActor({
        correlationId: 'test',
        identityId: 1,
        enterpriseId: 7,
        employeeId: 3,
        staffId: null,
        actorKind,
        isImpersonated: false,
        permissions: new Set<string>(),
      });
      return new EnterpriseActiveGuard(reflectorFor(metadata), enterprisesAt(status)).canActivate(
        context,
      );
    });

  const anyPermission = { [REQUIRED_ANY_PERMISSION_KEY]: ['conversations.view'] };
  const allPermissions = { [REQUIRED_PERMISSIONS_KEY]: ['inbox.view'] };

  it('refuses a SUSPENDED business on an any-permission route', async () => {
    /*
     * THE HOLE. Before the fix this resolved true: the guard never looked at
     * REQUIRED_ANY_PERMISSION_KEY, so every inbox route — eleven of them —
     * served a business that had been switched off.
     */
    await expect(run(EnterpriseStatus.Suspended, anyPermission)).rejects.toThrow(AppException);
  });

  it('refuses one still PENDING ACTIVATION on an any-permission route', async () => {
    await expect(run(EnterpriseStatus.PendingActivation, anyPermission)).rejects.toThrow(
      AppException,
    );
  });

  it('still refuses on an all-permissions route, as it always did', async () => {
    await expect(run(EnterpriseStatus.Suspended, allPermissions)).rejects.toThrow(AppException);
  });

  it('admits an active business', async () => {
    await expect(run(EnterpriseStatus.Active, anyPermission)).resolves.toBe(true);
  });

  it('lets staff through whatever the business status', async () => {
    // Staff reach exists to deal with a suspended business, so refusing them
    // would lock out the only people who can fix it.
    await expect(run(EnterpriseStatus.Suspended, anyPermission, ActorKind.Staff)).resolves.toBe(
      true,
    );
  });

  it('leaves identity-scoped routes alone', async () => {
    // /auth/me and enterprise switching must keep working for a pending
    // business, or its owner cannot even see why they are blocked.
    await expect(run(EnterpriseStatus.PendingActivation, {})).resolves.toBe(true);
  });
});
