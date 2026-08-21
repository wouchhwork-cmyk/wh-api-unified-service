import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityManager } from 'typeorm';
import type { ActorContext } from './actor-context';

export interface RequestContextStore {
  correlationId: string;
  actor?: ActorContext | undefined;
  /**
   * The ambient transaction, if one is open. Repositories resolve their manager
   * from here, which is what makes nested service calls join the outer
   * transaction instead of opening a second one (backend-design.md §6.1).
   */
  transactionManager?: EntityManager | undefined;
  /** Route label for logs and metrics, e.g. "POST /api/v1/conversations/:refId/reply". */
  route?: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Ambient per-request state. Nothing has to thread a correlation id or an actor
 * through every function signature, and the transaction manager travels with the
 * call stack rather than as a parameter on every repository method.
 */
export const RequestContext = {
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },

  /** The whole store, or undefined outside any request or job. */
  get(): RequestContextStore | undefined {
    return storage.getStore();
  },

  correlationId(): string | undefined {
    return storage.getStore()?.correlationId;
  },

  actor(): ActorContext | undefined {
    return storage.getStore()?.actor;
  },

  /**
   * Attaches the resolved actor. Called only by the guard chain, once the
   * identity, membership, and permissions are all known.
   */
  setActor(actor: ActorContext): void {
    const store = storage.getStore();
    if (store) store.actor = actor;
  },

  transactionManager(): EntityManager | undefined {
    return storage.getStore()?.transactionManager;
  },

  /**
   * Runs `fn` with `manager` as the ambient transaction. Only TransactionManager
   * calls this; the previous value is restored on exit so nested transactions
   * cannot leak their manager to the caller.
   */
  runInTransaction<T>(manager: EntityManager, fn: () => Promise<T>): Promise<T> {
    const store = storage.getStore();
    if (!store) {
      // No ambient store (a worker tick or a script): create one so the manager
      // still propagates to repositories.
      return storage.run({ correlationId: 'no-context', transactionManager: manager }, fn);
    }
    const previous = store.transactionManager;
    store.transactionManager = manager;
    return fn().finally(() => {
      store.transactionManager = previous;
    });
  },

  setRoute(route: string): void {
    const store = storage.getStore();
    if (store) store.route = route;
  },
};
