import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  EntityVersionRepository,
  type EntityVersionRow,
} from '@/database/repositories/entity-version.repository';
import { RequestContext } from '@/shared/context';
import { ActorKind, AuditEntityType } from '@/shared/enums';

export interface EntityVersionEvent {
  readonly entityType: AuditEntityType;
  readonly entityId: number;
  readonly enterpriseId: number;
  /**
   * The entity as it stands AFTER this change — the whole of it, redacted here
   * rather than by a filter somewhere else.
   *
   * A reward program carries `forwardConfig`, which holds a CREDENTIAL
   * REFERENCE. This table is append-only, so a secret written here can never be
   * taken back out; stating the snapshot explicitly is what keeps that from
   * happening by omission.
   */
  readonly snapshot: Record<string, unknown>;
}

/**
 * The record of what configuration LOOKED LIKE, version by version.
 *
 * The audit log and this are two halves of one answer and are written together.
 * `audit_logs` says a program was changed, by whom, from where. This says what
 * it then was — in full, so reconstructing March's configuration is reading one
 * row rather than replaying every diff since creation and hoping none of them
 * left a field out.
 *
 * That matters most where configuration decides money. An award made in March
 * was decided by the program as it stood in March, and "what was running then"
 * has to be answerable without the engine's own tables.
 *
 * The actor is read from ambient context, exactly as AuditService reads it, so
 * a caller cannot record a change under the wrong name.
 */
@Injectable()
export class EntityVersionService {
  constructor(
    private readonly versions: EntityVersionRepository,
    @InjectPinoLogger(EntityVersionService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Appends a version, and works out what moved since the last one.
   *
   * The diff is computed HERE rather than asked of the caller. Every call site
   * that has to describe its own change is a call site that can describe it
   * wrongly — which is the defect that made a role revocation read as a grant —
   * and the two snapshots already contain the answer.
   *
   * A FAILURE IS SWALLOWED ONLY OUTSIDE A TRANSACTION, exactly as
   * `AuditService` does, and for the reason measured there: a failed statement
   * aborts the transaction, catching it does not un-abort it, and Postgres then
   * turns the caller's COMMIT into a silent ROLLBACK that reports success.
   * Swallowing inside a transaction would hand back a committed-looking result
   * for work that had been discarded.
   */
  async record(event: EntityVersionEvent): Promise<number | null> {
    const actor = RequestContext.actor();
    const insideTransaction = RequestContext.transactionManager() !== undefined;

    try {
      const previous = await this.versions.latest(
        event.enterpriseId,
        event.entityType,
        event.entityId,
      );

      return await this.versions.append({
        enterpriseId: event.enterpriseId,
        entityType: event.entityType,
        entityId: event.entityId,
        snapshot: event.snapshot,
        changeSummary: diff(previous?.snapshot ?? null, event.snapshot),
        actorIdentityId: actor?.identityId ?? null,
        actorEmployeeId: actor?.employeeId ?? null,
        actorStaffId: actor?.staffId ?? null,
        actorKind: actor?.actorKind ?? ActorKind.System,
        isImpersonated: actor?.isImpersonated ?? false,
        correlationId: actor?.correlationId ?? RequestContext.correlationId() ?? null,
      });
    } catch (error) {
      /*
       * The snapshot goes in the log line, because a lost version row is a hole
       * in the history and the log is the only thing that can fill it. Call
       * sites are responsible for the snapshot carrying no secret, which is the
       * same contract that lets it be stored at all.
       */
      this.logger.error(
        {
          err: error,
          entityType: event.entityType,
          entityId: event.entityId,
          enterpriseId: event.enterpriseId,
          snapshot: event.snapshot,
        },
        insideTransaction
          ? 'FAILED TO WRITE ENTITY VERSION — the change is being rolled back with it'
          : 'FAILED TO WRITE ENTITY VERSION — the change itself had already committed',
      );
      if (insideTransaction) throw error;
      return null;
    }
  }

  /** The history, newest first. Bounded by the caller. */
  history(
    enterpriseId: number,
    entityType: AuditEntityType,
    entityId: number,
    limit: number,
  ): Promise<EntityVersionRow[]> {
    return this.versions.history(enterpriseId, entityType, entityId, limit);
  }
}

/**
 * What changed between two snapshots, as `{ field: { from, to } }`.
 *
 * Shallow by design. These snapshots are flat configuration — names, statuses,
 * timezones, dates — and a deep diff would invent structure the reader then has
 * to interpret. A nested value that differs is reported whole, which is honest
 * and legible: the snapshots are the authority, this is the summary.
 *
 * A field present in one and absent from the other counts as a change, so
 * adding or dropping a column shows up rather than passing silently.
 */
function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Record<string, unknown> {
  // The first version changed nothing — it IS the beginning. Saying "every
  // field went from nothing to something" would be noise on every create.
  if (before === null) return {};

  const changed: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key];
    const to = after[key];
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) {
      changed[key] = { from: from ?? null, to: to ?? null };
    }
  }
  return changed;
}
