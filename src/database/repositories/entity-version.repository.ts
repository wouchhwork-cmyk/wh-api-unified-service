import { Injectable } from '@nestjs/common';
import type { ActorKind } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface EntityVersionRow {
  readonly version: number;
  readonly snapshot: Record<string, unknown>;
  readonly changeSummary: Record<string, unknown>;
  readonly actorKind: ActorKind;
  readonly actorEmployeeId: number | null;
  readonly actorStaffId: number | null;
  readonly isImpersonated: boolean;
  readonly correlationId: string | null;
  readonly createdAt: Date;
}

export interface EntityVersionInsert {
  readonly enterpriseId: number;
  readonly entityType: string;
  readonly entityId: number;
  readonly snapshot: Record<string, unknown>;
  readonly changeSummary: Record<string, unknown>;
  readonly actorIdentityId: number | null;
  readonly actorEmployeeId: number | null;
  readonly actorStaffId: number | null;
  readonly actorKind: ActorKind;
  readonly isImpersonated: boolean;
  readonly correlationId: string | null;
}

const COLUMNS = `version, snapshot, change_summary AS "changeSummary",
       actor_kind AS "actorKind", actor_employee_id AS "actorEmployeeId",
       actor_staff_id AS "actorStaffId", is_impersonated AS "isImpersonated",
       correlation_id AS "correlationId", created_at AS "createdAt"`;

/**
 * INSERT and SELECT only. An append-only trigger on the table refuses anything
 * else, so there is no `update` here to be tempted by.
 */
@Injectable()
export class EntityVersionRepository extends BaseRepository {
  /**
   * Appends the next version, allocating its number in the same statement.
   *
   * THE NUMBER IS CHOSEN BY THE DATABASE, not read and then written back. A
   * read-then-insert would let two concurrent editors both see version 3 and
   * both write version 4, and the second would be an overwrite of a history
   * that is supposed to be immutable.
   *
   * `MAX(version) + 1` computed inside the INSERT narrows that window, and the
   * unique index closes it: a loser raises rather than corrupting the chain.
   * That is the honest shape — the caller sees an error on a genuine collision
   * instead of the history quietly disagreeing with itself.
   */
  async append(input: EntityVersionInsert): Promise<number> {
    const { rows } = await this.mutate<{ version: number }>(
      `INSERT INTO entity_versions
              (enterprise_id, entity_type, entity_id, version, snapshot, change_summary,
               actor_identity_id, actor_employee_id, actor_staff_id, actor_kind,
               is_impersonated, correlation_id)
       SELECT $1, $2::varchar, $3,
              COALESCE(MAX(v.version), 0) + 1,
              $4::jsonb, $5::jsonb, $6, $7, $8, $9::varchar, $10, $11
         FROM entity_versions v
        WHERE v.enterprise_id = $1 AND v.entity_type = $2::varchar AND v.entity_id = $3
       RETURNING version`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.entityType,
        input.entityId,
        JSON.stringify(input.snapshot),
        JSON.stringify(input.changeSummary),
        input.actorIdentityId,
        input.actorEmployeeId,
        input.actorStaffId,
        input.actorKind,
        input.isImpersonated,
        input.correlationId,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('entity version insert returned no row');
    return row.version;
  }

  /** The latest snapshot, or null when nothing has been recorded yet. */
  async latest(
    enterpriseId: number,
    entityType: string,
    entityId: number,
  ): Promise<EntityVersionRow | null> {
    const rows = await this.query<EntityVersionRow>(
      `SELECT ${COLUMNS}
         FROM entity_versions
        WHERE enterprise_id = $1 AND entity_type = $2::varchar AND entity_id = $3
          AND is_deleted = false
        ORDER BY version DESC
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), entityType, entityId],
    );
    return rows[0] ?? null;
  }

  /**
   * The history, newest first.
   *
   * BOUNDED, and ordered by `version` rather than `created_at`: two versions
   * written in the same millisecond must still come back in the order they
   * happened, and `version` is the only column that always knows.
   */
  async history(
    enterpriseId: number,
    entityType: string,
    entityId: number,
    limit: number,
  ): Promise<EntityVersionRow[]> {
    return this.query<EntityVersionRow>(
      `SELECT ${COLUMNS}
         FROM entity_versions
        WHERE enterprise_id = $1 AND entity_type = $2::varchar AND entity_id = $3
          AND is_deleted = false
        ORDER BY version DESC
        LIMIT $4`,
      [this.requireEnterprise(enterpriseId), entityType, entityId, limit],
    );
  }
}
