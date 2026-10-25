import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AuditLogRepository } from '@/database/repositories/audit-log.repository';
import { RequestContext } from '@/shared/context';
import { ActorKind, AuditAction, AuditEntityType, AuditStatus } from '@/shared/enums';

export interface AuditEvent {
  readonly action: AuditAction;
  readonly entityType: AuditEntityType;
  readonly entityId: number | null;
  /**
   * The enterprise the action affected — NOT the actor's own scope. A platform
   * admin has no enterprise of their own, and the interesting question about
   * their action is always "whose business did this touch".
   */
  readonly enterpriseId: number | null;
  /** Before/after values. Must never carry a secret or a token. */
  readonly changes?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly status?: AuditStatus;
}

/**
 * The record of who did what to whom.
 *
 * Every write reachable by internal staff has to land here. Staff can act across
 * tenant boundaries by design, which makes the audit trail the only thing that
 * distinguishes legitimate support work from an insider looking through a
 * customer's inbox.
 *
 * The actor is read from the ambient request context rather than passed in, so a
 * caller cannot record an action under the wrong actor — accidentally or
 * otherwise.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly logs: AuditLogRepository,
    @InjectPinoLogger(AuditService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Records an event, joining the caller's transaction when there is one, so an
   * action that rolls back leaves no audit row claiming it happened.
   *
   * A FAILURE IS SWALLOWED ONLY OUTSIDE A TRANSACTION, and that distinction is
   * not a refinement — it is the difference between a logged inconvenience and
   * silently throwing away the caller's work.
   *
   * The original rule was "always swallow", on the reasoning that throwing
   * would turn an audit outage into an outage of every mutating endpoint. That
   * reasoning does not survive contact with Postgres. A failed statement puts
   * the transaction into an ABORTED state; catching the error in JavaScript
   * does not un-abort it. Measured against the real database:
   *
   *     INSERT INTO audit_logs ... (fails a foreign key)
   *     SELECT 1            -> ERROR: current transaction is aborted
   *     COMMIT              -> reports SUCCESS
   *
   * That last line is the whole problem. **Postgres turns a COMMIT on an
   * aborted transaction into a ROLLBACK and reports success**, so swallowing
   * here handed the caller a committed-looking result for work that had been
   * thrown away entirely — and the log line said "the action itself was not
   * rolled back", which was precisely backwards.
   *
   * So: inside a transaction the error is rethrown, the transaction manager
   * rolls back honestly, and the caller gets a failure that matches reality.
   * Outside one there is no transaction to poison, the state change has already
   * committed on its own, and swallowing is still the right trade — a lost
   * audit row is worth more than a failed request the user would have to retry.
   */
  async record(event: AuditEvent): Promise<void> {
    const actor = RequestContext.actor();
    const insideTransaction = RequestContext.transactionManager() !== undefined;

    try {
      await this.logs.insert({
        enterpriseId: event.enterpriseId,
        actorIdentityId: actor?.identityId ?? null,
        actorEmployeeId: actor?.employeeId ?? null,
        actorStaffId: actor?.staffId ?? null,
        actorKind: actor?.actorKind ?? ActorKind.System,
        isImpersonated: actor?.isImpersonated ?? false,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        changes: event.changes ?? {},
        metadata: {
          ...(event.metadata ?? {}),
          correlationId: actor?.correlationId ?? RequestContext.correlationId() ?? null,
        },
        ipAddress: RequestContext.ipAddress() ?? null,
        userAgent: RequestContext.userAgent() ?? null,
        status: event.status ?? AuditStatus.Success,
      });
    } catch (error) {
      /*
       * EVERYTHING NEEDED TO RECONSTRUCT THE LOST ROW.
       *
       * This logged the action and the entity type and nothing else, so a failed
       * audit write left no way to know WHAT had happened — which is the one
       * thing an audit log exists to answer. The log line is the compensating
       * control for swallowing the error, so it has to carry the record.
       *
       * `changes` and `metadata` are ours, not the customer's: field names and
       * status transitions. The redact list covers `payload` and the named
       * secrets if either ever carried one.
       */
      this.logger.error(
        {
          err: error,
          action: event.action,
          entityType: event.entityType,
          entityId: event.entityId,
          enterpriseId: event.enterpriseId,
          changes: event.changes ?? {},
          metadata: event.metadata ?? {},
          actorKind: actor?.actorKind ?? ActorKind.System,
          actorEmployeeId: actor?.employeeId ?? null,
          actorStaffId: actor?.staffId ?? null,
        },
        insideTransaction
          ? 'FAILED TO WRITE AUDIT LOG — the action is being rolled back with it'
          : 'FAILED TO WRITE AUDIT LOG — the action itself had already committed',
      );

      /*
       * The transaction is already unusable at this point; the only choice is
       * whether the caller finds out now or is told their work succeeded when
       * it did not.
       */
      if (insideTransaction) throw error;
    }
  }
}
