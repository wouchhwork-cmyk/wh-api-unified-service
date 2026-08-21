import type { ActorKind } from '@/shared/enums';

/**
 * THE ONLY SOURCE OF IDENTITY IN THE APPLICATION (backend-design.md §7.1).
 *
 * Built once by the guards, carried in AsyncLocalStorage, and never
 * reconstructed from a request body — a client-supplied enterpriseId is the
 * classic tenant-escape vector.
 */
export interface ActorContext {
  readonly identityId: number;
  /** null only for a staff actor who has not selected an enterprise yet. */
  readonly enterpriseId: number | null;
  readonly memberId: number | null;
  readonly staffId: number | null;
  readonly actorKind: ActorKind;
  /** Staff acting inside an enterprise — audited (schema.md §25). */
  readonly isImpersonated: boolean;
  /** Resolved once per request, never cached across requests. */
  readonly permissions: ReadonlySet<string>;
  readonly correlationId: string;
}

/**
 * An actor whose enterprise is known. Endpoints that touch tenant data require
 * this, so "did you check enterpriseId is set" is a compile-time question rather
 * than a runtime one.
 */
export type ScopedActorContext = ActorContext & { readonly enterpriseId: number };

export function isScoped(actor: ActorContext): actor is ScopedActorContext {
  return actor.enterpriseId !== null;
}
