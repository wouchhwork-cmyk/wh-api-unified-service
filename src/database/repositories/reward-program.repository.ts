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
  readonly budgetMinor: number | null;
  readonly budgetCurrencyCode: string | null;
  readonly spentMinor: number;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly forwardProviderCode: string | null;
}

const COLUMNS = `id, ref_id AS "refId", name, status, timezone,
       default_currency_code AS "defaultCurrencyCode",
       budget_minor AS "budgetMinor", budget_currency_code AS "budgetCurrencyCode",
       spent_minor AS "spentMinor", starts_at AS "startsAt", ends_at AS "endsAt",
       forward_provider_code AS "forwardProviderCode"`;

@Injectable()
export class RewardProgramRepository extends BaseRepository {
  async create(input: {
    enterpriseId: number;
    name: string;
    timezone: string;
    defaultCurrencyCode: string | null;
    budgetMinor: number | null;
    budgetCurrencyCode: string | null;
    startsAt: Date | null;
    endsAt: Date | null;
  }): Promise<RewardProgramRow> {
    const { rows } = await this.mutate<RewardProgramRow>(
      `INSERT INTO reward_programs
              (enterprise_id, name, timezone, default_currency_code,
               budget_minor, budget_currency_code, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLUMNS}`,
      [
        input.enterpriseId,
        input.name,
        input.timezone,
        input.defaultCurrencyCode,
        input.budgetMinor,
        input.budgetCurrencyCode,
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

  async list(enterpriseId: number, limit: number): Promise<RewardProgramRow[]> {
    return this.query<RewardProgramRow>(
      `SELECT ${COLUMNS} FROM reward_programs
        WHERE enterprise_id = $1 AND is_deleted = false
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [enterpriseId, limit],
    );
  }

  /**
   * Moves the switch.
   *
   * `affected` is returned so the service can tell "no such program" from
   * "nothing changed" — a silent zero-row UPDATE is how a 404 becomes a 200.
   */
  async setStatus(
    enterpriseId: number,
    refId: string,
    status: RewardProgramStatus,
  ): Promise<boolean> {
    const { affected } = await this.mutate(
      `UPDATE reward_programs SET status = $3
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false`,
      [enterpriseId, refId, status],
    );
    return affected > 0;
  }
}
