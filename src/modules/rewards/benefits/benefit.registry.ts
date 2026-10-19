import { Injectable } from '@nestjs/common';
import { RewardBenefitKind } from '@/shared/enums';
import type { BenefitHandler, BenefitHandlerMap } from './benefit.types';
import { ConvertValueBenefit } from './convert-value.benefit';
import { GrantCurrencyBenefit } from './grant-currency.benefit';
import { GrantPointsBenefit } from './grant-points.benefit';
import { IssueEntitlementBenefit } from './issue-entitlement.benefit';

/**
 * Every benefit kind, mapped to the one handler that applies it.
 *
 * THIS IS THE COMPLETENESS CHECK. `BenefitHandlerMap` is
 * `{ [K in RewardBenefitKind]: BenefitHandler<K> }`, so:
 *
 *   - omit a kind and the build fails with TS1360, NAMING the missing member;
 *   - file a handler under the wrong key and it fails with TS2322, saying which.
 *
 * Neither is a lint rule or a convention somebody has to remember. Adding a
 * benefit kind is four files, and the compiler demands three of them by name.
 *
 * NO DECORATOR SCANNING. `DiscoveryService` would let a handler register
 * itself, at the price of this check — a missing handler would then surface at
 * runtime, on a customer's award, the way Keycloak discovers an unregistered
 * authenticator on a live user's login. An explicit map is also greppable.
 */
@Injectable()
export class BenefitRegistry {
  private readonly handlers: BenefitHandlerMap;

  constructor(
    grantPoints: GrantPointsBenefit,
    grantCurrency: GrantCurrencyBenefit,
    issueEntitlement: IssueEntitlementBenefit,
    convertValue: ConvertValueBenefit,
  ) {
    this.handlers = {
      [RewardBenefitKind.GrantPoints]: grantPoints,
      [RewardBenefitKind.GrantCurrency]: grantCurrency,
      [RewardBenefitKind.IssueEntitlement]: issueEntitlement,
      [RewardBenefitKind.ConvertValue]: convertValue,
    };
  }

  /**
   * The handler for a kind.
   *
   * Generic over the discriminant rather than taking the plain union: with
   * `map[benefit.kind]` TypeScript takes the union of every handler and
   * intersects their parameter types down to `never`, which is why people
   * reach for a cast here. This way there is no cast.
   */
  get<K extends RewardBenefitKind>(kind: K): BenefitHandler<K> {
    return this.handlers[kind];
  }

  /**
   * For a kind that came out of the DATABASE, where the type cannot vouch for it.
   *
   * `get` is honest for a kind parsed from the union — it exists by
   * construction. A `benefit_kind` read from a stored row is a string that was
   * valid when it was written and may name something this build no longer has,
   * so this returns `undefined` rather than pretending otherwise.
   */
  tryGet(kind: string): BenefitHandler<RewardBenefitKind> | undefined {
    if (!Object.values(RewardBenefitKind).includes(kind as RewardBenefitKind)) {
      return undefined;
    }
    return this.handlers[kind as RewardBenefitKind];
  }

  /** Whether the factor may scale this kind. 0.6 of a free coffee is nothing. */
  isScalable(kind: RewardBenefitKind): boolean {
    return this.handlers[kind].scalable;
  }

  /**
   * Checked at boot, not at dispatch.
   *
   * The type system guarantees a handler EXISTS for every kind. It cannot
   * guarantee the instance was actually injected — a misconfigured module
   * yields `undefined` at runtime with the types still happy. Keycloak
   * discovers that case as a RuntimeException on a live login, with an error
   * message that apologises for the design. This is ~10 lines to never do that.
   */
  assertComplete(): void {
    const missing = Object.values(RewardBenefitKind).filter(
      (kind) => this.handlers[kind] === undefined,
    );
    if (missing.length > 0) {
      throw new Error(`reward benefit handlers not wired: ${missing.join(', ')}`);
    }

    const misfiled = Object.values(RewardBenefitKind).filter(
      (kind) => this.handlers[kind].kind !== kind,
    );
    if (misfiled.length > 0) {
      throw new Error(`reward benefit handlers filed under the wrong key: ${misfiled.join(', ')}`);
    }
  }
}
