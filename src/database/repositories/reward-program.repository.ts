import { Injectable } from '@nestjs/common';
import { RewardProgramStatus } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface RewardProgramRow {
  readonly id: number;
  readonly refId: string;
  readonly name: string;
  readonly status: RewardProgramStatus;
  readonly timezone: string;
  readonly defaultCurrencyCode: string | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly forwardProviderCode: string | null;
}

const COLUMNS = `id, ref_id AS "refId", name, status, timezone,
       default_currency_code AS "defaultCurrencyCode",
       starts_at AS "startsAt", ends_at AS "endsAt",
       forward_provider_code AS "forwardProviderCode"`;

@Injectable()
export class RewardProgramRepository extends BaseRepository {
  async create(input: {
    enterpriseId: number;
    name: string;
    timezone: string;
    defaultCurrencyCode: string | null;
    startsAt: Date | null;
    endsAt: Date | null;
  }): Promise<RewardProgramRow> {
    const { rows } = await this.mutate<RewardProgramRow>(
      `INSERT INTO reward_programs
              (enterprise_id, name, timezone, default_currency_code,
               starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [
        input.enterpriseId,
        input.name,
        input.timezone,
        input.defaultCurrencyCode,
        input.startsAt,
        input.endsAt,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('create program returned no row');
    return row;
  }

  async findByRefId(enterpriseId: number, refId: string): Promise<RewardProgramRow | null> {
    const rows = await this.query<RewardProgramRow>(
      `SELECT ${COLUMNS} FROM reward_programs
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false`,
      [enterpriseId, refId],
    );
    return rows[0] ?? null;
  }

  async findById(enterpriseId: number, id: number): Promise<RewardProgramRow | null> {
    const rows = await this.query<RewardProgramRow>(
      `SELECT ${COLUMNS} FROM reward_programs
        WHERE enterprise_id = $1 AND id = $2 AND is_deleted = false`,
      [enterpriseId, id],
    );
    return rows[0] ?? null;
  }

  /**
   * The programmes a business works with.
   *
   * ARCHIVED ONES ARE EXCLUDED BY DEFAULT and asked for by name. They are kept
   * for the record — what ran, what it spent, what it awarded — but a retired
   * programme cluttering the working list is how somebody edits the wrong one.
   */
  async list(
    enterpriseId: number,
    limit: number,
    status: RewardProgramStatus | null = null,
  ): Promise<RewardProgramRow[]> {
    return this.query<RewardProgramRow>(
      `SELECT ${COLUMNS} FROM reward_programs
        WHERE enterprise_id = $1 AND is_deleted = false
          AND ($3::varchar IS NULL AND status <> $4 OR status = $3::varchar)
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [enterpriseId, limit, status, RewardProgramStatus.Archived],
    );
  }

  /**
   * Moves the switch.
   *
   * ARCHIVED IS TERMINAL, and the guard is in the WHERE clause rather than a
   * read followed by a write: two concurrent requests, one archiving and one
   * reactivating, would both pass a check-then-write and the loser would
   * resurrect a programme somebody had just retired.
   *
   * Three outcomes, distinguished, because a silent zero-row UPDATE is how a
   * 404 becomes a 200 — and how "this is archived" becomes "this does not
   * exist", which sends somebody looking for a programme they are staring at.
   */
  async setStatus(
    enterpriseId: number,
    refId: string,
    status: RewardProgramStatus,
  ): Promise<'moved' | 'archived' | 'missing'> {
    const { rows } = await this.mutate<{ status: RewardProgramStatus }>(
      `UPDATE reward_programs SET status = $3
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false
          AND status <> $4
      RETURNING status`,
      [enterpriseId, refId, status, RewardProgramStatus.Archived],
    );
    if (rows.length > 0) return 'moved';

    /* Only on the failure path, so the ordinary case stays one statement. */
    const existing = await this.findByRefId(enterpriseId, refId);
    return existing ? 'archived' : 'missing';
  }
}
