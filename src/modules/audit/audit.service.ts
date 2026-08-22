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
   * A failure to audit is logged and swallowed. That is a deliberate trade and
   * the only one available: throwing would turn an audit outage into an outage
   * of every mutating endpoint. The error log is the compensating control.
   */
  async record(event: AuditEvent): Promise<void> {
    const actor = RequestContext.actor();

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
      this.logger.error(
        { err: error, action: event.action, entityType: event.entityType },
        'FAILED TO WRITE AUDIT LOG — the action itself was not rolled back',
      );
    }
  }
}
