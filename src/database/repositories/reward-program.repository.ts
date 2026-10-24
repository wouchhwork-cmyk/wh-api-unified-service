import { Injectable } from '@nestjs/common';
import { RewardProgramStatus } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface RewardProgramRow {
  readonly id: number;
  readonly refId: string;
  readonly name: string;
  readonly status: RewardProgramStatus;
  /**
   * THE BUSINESS'S, not the programme's, and named so nobody mistakes it.
   *
   * A programme used to carry its own copy of each, taken at creation and
   * never reconciled, so two programmes in one business could disagree about
   * when Tuesday starts and what money means. They are joined from
   * `enterprises` here — one resolution point, read by every caller — rather
   * than looked up separately wherever they happen to be needed.
   */
  /** NULL = the business has not chosen one; anything needing a calendar day is refused. */
  readonly enterpriseTimezone: string | null;
  /** NULL = the business has not chosen one; a money benefit is refused. */
  readonly enterpriseCurrencyCode: string | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly forwardProviderCode: string | null;
}

/*
 * Aliased, because every read now joins `enterprises`. The join is INNER: a
 * programme without a business cannot exist — the foreign key says so — and a
 * LEFT join would invite a NULL timezone that every caller would then have to
 * defend against for a row that cannot occur.
 */
const COLUMNS = `p.id, p.ref_id AS "refId", p.name, p.status,
       e.timezone AS "enterpriseTimezone",
       e.currency_code AS "enterpriseCurrencyCode",
       p.starts_at AS "startsAt", p.ends_at AS "endsAt",
       p.forward_provider_code AS "forwardProviderCode"`;

const FROM = `FROM reward_programs p JOIN enterprises e ON e.id = p.enterprise_id`;

@Injectable()
export class RewardProgramRepository extends BaseRepository {
  /**
   * Inserts, then reads back through the join.
   *
   * `RETURNING` cannot reach the joined business columns, and the alternative
   * — returning the bare programme and letting callers wonder why the
   * timezone is missing on a freshly created one — is the kind of difference
   * that only shows up in the one code path nobody tested. Two statements in
   * the caller's transaction is the cheaper honesty.
   */
  async create(input: {
    enterpriseId: number;
    name: string;
    startsAt: Date | null;
    endsAt: Date | null;
  }): Promise<RewardProgramRow> {
    const { rows } = await this.mutate<{ id: number }>(
      `INSERT INTO reward_programs (enterprise_id, name, starts_at, ends_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.enterpriseId, input.name, input.startsAt, input.endsAt],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('create program returned no row');

    const created = await this.findById(input.enterpriseId, id);
    if (!created) throw new Error('create program could not read the row back');
    return created;
  }

  async findByRefId(enterpriseId: number, refId: string): Promise<RewardProgramRow | null> {
    const rows = await this.query<RewardProgramRow>(
      `SELECT ${COLUMNS} ${FROM}
        WHERE p.enterprise_id = $1 AND p.ref_id = $2 AND p.is_deleted = false`,
      [enterpriseId, refId],
    );
    return rows[0] ?? null;
  }

  async findById(enterpriseId: number, id: number): Promise<RewardProgramRow | null> {
    const rows = await this.query<RewardProgramRow>(
      `SELECT ${COLUMNS} ${FROM}
        WHERE p.enterprise_id = $1 AND p.id = $2 AND p.is_deleted = false`,
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
      `SELECT ${COLUMNS} ${FROM}
        WHERE p.enterprise_id = $1 AND p.is_deleted = false
          AND ($3::varchar IS NULL AND p.status <> $4 OR p.status = $3::varchar)
        ORDER BY p.created_at DESC, p.id DESC
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
