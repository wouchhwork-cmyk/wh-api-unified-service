import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '@/shared/guards/permissions.guard';
import { RequestContext } from '@/shared/context';
import {
  IS_PUBLIC_KEY,
  REQUIRED_ANY_PERMISSION_KEY,
  REQUIRED_PERMISSIONS_KEY,
} from '@/shared/decorators';
import { ActorKind } from '@/shared/enums';
import { AppException } from '@/shared/errors';

/**
 * Gate 2: does the actor hold what the route declares?
 *
 * WRITTEN BECAUSE THE OR BRANCH HAD NO TEST. `@RequireAnyPermission` was added
 * so the inbox routes could serve three kinds of thread governed by three
 * different codes — and nothing asserted that holding NONE of them is refused,
 * nor that the AND branch still behaves as it did. A widening with no test is
 * the shape of change that quietly becomes a hole.
 *
 * The guard is exercised directly rather than through HTTP: what is under test
 * is a set comparison and its precedence, and four layers of request setup
 * would hide which branch fired.
 */
describe('the permissions guard', () => {
  /** A reflector that answers with whatever metadata the test declares. */
  const reflectorFor = (metadata: Record<string, unknown>): Reflector =>
    ({
      getAllAndOverride: (key: string) => metadata[key],
    }) as unknown as Reflector;

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;

  /** Runs the guard with an actor holding exactly these codes. */
  const withPermissions = (held: string[], metadata: Record<string, unknown>): boolean =>
    RequestContext.run({ correlationId: 'test' }, () => {
      RequestContext.setActor({
        identityId: 1,
        enterpriseId: 1,
        employeeId: 1,
        staffId: null,
        actorKind: ActorKind.Employee,
        isImpersonated: false,
        permissions: new Set(held),
        correlationId: 'test',
      });
      return new PermissionsGuard(reflectorFor(metadata)).canActivate(context);
    });

  const denial = (held: string[], metadata: Record<string, unknown>): AppException => {
    try {
      withPermissions(held, metadata);
    } catch (error) {
      return error as AppException;
    }
    throw new Error('expected the guard to refuse, and it did not');
  };

  describe('holding ANY of several codes', () => {
    it('admits somebody holding exactly one of them', () => {
      /*
       * The case the decorator exists for: a business granted only
       * `mentions.view` must be able to reach the endpoint that serves
       * mentions, which is the same endpoint that serves the private inbox.
       */
      const passed = withPermissions(['mentions.view'], {
        [REQUIRED_ANY_PERMISSION_KEY]: [
          'conversations.view',
          'comments.view',
          'mentions.view',
        ],
      });

      expect(passed).toBe(true);
    });

    it('admits somebody holding all of them', () => {
      const passed = withPermissions(['conversations.view', 'mentions.view'], {
        [REQUIRED_ANY_PERMISSION_KEY]: ['conversations.view', 'mentions.view'],
      });

      expect(passed).toBe(true);
    });

    it('REFUSES somebody holding none of them', () => {
      // The assertion that was missing entirely.
      const error = denial(['posts.view'], {
        [REQUIRED_ANY_PERMISSION_KEY]: ['conversations.view', 'mentions.view'],
      });

      expect(error.code).toBe('PERMISSION_DENIED');
    });

    it('REFUSES an actor holding nothing at all', () => {
      const error = denial([], {
        [REQUIRED_ANY_PERMISSION_KEY]: ['conversations.view'],
      });

      expect(error.code).toBe('PERMISSION_DENIED');
    });

    it('names the codes it wanted, so a client author need not guess', () => {
      const error = denial([], {
        [REQUIRED_ANY_PERMISSION_KEY]: ['conversations.view', 'mentions.view'],
      });

      const issues = (error.details ?? []).map((detail) => detail.issue);
      expect(issues).toEqual(['conversations.view', 'mentions.view']);
    });
  });

  describe('holding ALL of several codes, which is the older rule', () => {
    it('admits somebody holding every one', () => {
      const passed = withPermissions(['a.view', 'b.view'], {
        [REQUIRED_PERMISSIONS_KEY]: ['a.view', 'b.view'],
      });

      expect(passed).toBe(true);
    });

    it('REFUSES somebody missing one', () => {
      // An endpoint touching two resources needs rights to both — the widening
      // must not have turned AND into OR.
      const error = denial(['a.view'], {
        [REQUIRED_PERMISSIONS_KEY]: ['a.view', 'b.view'],
      });

      expect((error.details ?? []).map((detail) => detail.issue)).toEqual(['b.view']);
    });
  });

  describe('a route that declares BOTH', () => {
    /*
     * Nothing declares both today. The precedence is fixed now so that the
     * first route to do so gets the strict reading — one of the ANY set AND all
     * of the ALL set — rather than whichever happened to fall out.
     */
    it('needs one of the any-set and all of the all-set', () => {
      const passed = withPermissions(['mentions.view', 'posts.view'], {
        [REQUIRED_ANY_PERMISSION_KEY]: ['conversations.view', 'mentions.view'],
        [REQUIRED_PERMISSIONS_KEY]: ['posts.view'],
      });

      expect(passed).toBe(true);
    });

    it('REFUSES when the any-set is satisfied but the all-set is not', () => {
      const error = denial(['mentions.view'], {
        [REQUIRED_ANY_PERMISSION_KEY]: ['mentions.view'],
        [REQUIRED_PERMISSIONS_KEY]: ['posts.view'],
      });

      expect((error.details ?? []).map((detail) => detail.issue)).toEqual(['posts.view']);
    });

    it('REFUSES when the all-set is satisfied but the any-set is not', () => {
      const error = denial(['posts.view'], {
        [REQUIRED_ANY_PERMISSION_KEY]: ['mentions.view'],
        [REQUIRED_PERMISSIONS_KEY]: ['posts.view'],
      });

      expect((error.details ?? []).map((detail) => detail.field)).toEqual(['anyPermission']);
    });
  });

  describe('routes that declare nothing', () => {
    it('lets a public route through without looking at the actor', () => {
      const passed = new PermissionsGuard(
        reflectorFor({ [IS_PUBLIC_KEY]: true }),
      ).canActivate(context);

      expect(passed).toBe(true);
    });

    it('lets a route with no permission metadata through', () => {
      // Authentication is a different guard's job; this one only enforces what
      // a route actually declares.
      expect(withPermissions([], {})).toBe(true);
    });

    it('treats an EMPTY declared list as no declaration', () => {
      expect(
        withPermissions([], {
          [REQUIRED_ANY_PERMISSION_KEY]: [],
          [REQUIRED_PERMISSIONS_KEY]: [],
        }),
      ).toBe(true);
    });
  });

  describe('with no actor at all', () => {
    it('refuses rather than reading an undefined permission set', () => {
      /*
       * Reached only if the guard order were changed so this ran before
       * authentication. It must fail closed rather than throw a TypeError that
       * an exception filter would render as a 500.
       */
      let thrown: AppException | null = null;
      try {
        new PermissionsGuard(
          reflectorFor({ [REQUIRED_ANY_PERMISSION_KEY]: ['conversations.view'] }),
        ).canActivate(context);
      } catch (error) {
        thrown = error as AppException;
      }

      expect(thrown?.code).toBe('AUTH_TOKEN_INVALID');
    });
  });
});
