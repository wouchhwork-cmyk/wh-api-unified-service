import { Injectable } from '@nestjs/common';
import { ModelCallStatus, type ModelCallPurpose } from '@/shared/enums';
import { BaseRepository } from './base.repository';

/** What is known BEFORE the call goes out. */
export interface ModelCallIntent {
  readonly enterpriseId: number;
  readonly provider: string;
  readonly model: string;
  readonly purpose: ModelCallPurpose;
  readonly messageId?: number | null;
  readonly mediaKey?: string | null;
  readonly promptVersion?: number | null;
  /** The exact prompt, as a fingerprint. Never the prompt itself. */
  readonly promptHash?: string | null;
  /** The messages it was shown, in order, by public ref id. */
  readonly turnRefs?: readonly string[] | null;
}

/** What is known once it comes back, or fails to. */
export interface ModelCallOutcome {
  readonly status: ModelCallStatus.Ok | ModelCallStatus.Failed;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly totalTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly durationMs?: number | null;
  readonly truncated?: boolean;
  readonly failureCode?: string | null;
  /** Already redacted by the caller. Never a prompt, never a response. */
  readonly failureReason?: string | null;
}

/** One recorded call, as a reader of the trail needs it. */
export interface ModelCallRow {
  readonly refId: string;
  readonly provider: string;
  readonly model: string;
  readonly purpose: ModelCallPurpose;
  readonly status: ModelCallStatus;
  readonly promptVersion: number | null;
  readonly promptHash: string | null;
  readonly turnRefs: string[] | null;
  readonly messageId: number | null;
  readonly mediaKey: string | null;
  readonly totalTokens: number | null;
  readonly durationMs: number | null;
  readonly failureCode: string | null;
  readonly createdAt: Date;
}

export interface ModelSpendRow {
  readonly provider: string;
  readonly model: string;
  readonly purpose: ModelCallPurpose;
  readonly calls: number;
  readonly failed: number;
  /** Went out, and nobody ever learned the outcome. Possibly billed. */
  readonly unknown: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * The record of every model call this service made.
 *
 * APPEND ONLY. A call happened or it did not; there is nothing to update
 * afterwards, and a row that can be rewritten is a record nobody can rely on
 * when the question is what something cost.
 */
@Injectable()
export class ModelCallRepository extends BaseRepository {
  /**
   * Opens the record, BEFORE the call goes out.
   *
   * THE ORDER IS THE WHOLE POINT. Recording afterwards looks equivalent and
   * is not: the window between a model answering and the insert landing is
   * exactly where a deploy, an OOM or a kill costs a call that was made,
   * very likely billed, and left no trace. A row written first survives all
   * three, and the sweep below turns it into an honest "we never found out".
   *
   * IT THROWS, and that is deliberate. Everything else about this repository
   * swallows, because bookkeeping must not take down the work it describes.
   * This one runs BEFORE the work, and a failure to insert one row means the
   * database is unavailable — in which case the reply could not have been
   * stored or sent either. Failing here costs a call that was going to fail
   * a second later anyway; proceeding spends money with nothing to show for
   * it. Cheaper to stop.
   */
  async begin(input: ModelCallIntent): Promise<{ id: number; refId: string }> {
    const { rows } = await this.mutate<{ id: string; ref_id: string }>(
      `INSERT INTO model_calls
         (enterprise_id, provider, model, purpose, status, message_id, media_key,
          prompt_version, prompt_hash, turn_refs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, ref_id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.provider,
        input.model,
        input.purpose,
        ModelCallStatus.InFlight,
        input.messageId ?? null,
        input.mediaKey ?? null,
        input.promptVersion ?? null,
        input.promptHash ?? null,
        input.turnRefs ? JSON.stringify(input.turnRefs) : null,
      ],
    );
    return { id: Number(rows[0]?.id), refId: rows[0]?.ref_id ?? '' };
  }

  /**
   * Closes it, once the answer is in — or once it is clear there is none.
   *
   * IT NEVER THROWS, which is the mirror image of `begin`. By the time this
   * runs the call has already happened; a bookkeeping failure that took the
   * customer's reply down with it would be the worse bug by a wide margin,
   * and the row it leaves behind is not lost — it stays in flight and the
   * sweep settles it as unknown, which is exactly what it is.
   *
   * The model is restated because a provider may answer on a different one
   * than was asked for, and the record should say which actually ran.
   */
  async settle(id: number, outcome: ModelCallOutcome, model?: string): Promise<void> {
    try {
      await this.mutate(
        `UPDATE model_calls
            SET status = $2,
                model = COALESCE($3, model),
                input_tokens = $4, output_tokens = $5, total_tokens = $6,
                cached_input_tokens = $7, reasoning_tokens = $8,
                duration_ms = $9, truncated = $10,
                failure_code = $11, failure_reason = $12
          WHERE id = $1 AND status = $13`,
        [
          id,
          outcome.status,
          model ?? null,
          outcome.inputTokens ?? null,
          outcome.outputTokens ?? null,
          outcome.totalTokens ?? null,
          outcome.cachedInputTokens ?? null,
          outcome.reasoningTokens ?? null,
          outcome.durationMs ?? null,
          outcome.truncated ?? false,
          outcome.failureCode ?? null,
          outcome.failureReason?.slice(0, 500) ?? null,
          ModelCallStatus.InFlight,
        ],
      );
    } catch {
      /* Deliberately swallowed — see above. The sweep is the backstop. */
    }
  }

  /**
   * Settles calls whose process never came back.
   *
   * AS UNKNOWN RATHER THAN FAILED. "It failed" is a claim about the provider;
   * what actually happened is that we stopped listening. The call may well
   * have succeeded and been billed, and a record that guesses is worse than
   * one that says it does not know.
   *
   * Age rather than a lease, because there is no work to hand back — the
   * row is a note about something that already happened, and the only
   * question is whether anyone is still waiting to write to it.
   */
  async settleAbandoned(olderThanMs: number): Promise<number> {
    const { rows } = await this.mutate<{ id: string }>(
      `UPDATE model_calls
          SET status = $1
        WHERE status = $2
          AND created_at < now() - ($3::int * interval '1 millisecond')
      RETURNING id`,
      [ModelCallStatus.Unknown, ModelCallStatus.InFlight, Math.max(0, Math.trunc(olderThanMs))],
    );
    return rows.length;
  }

  /**
   * What one business spent over a window, grouped the way a bill reads.
   *
   * Served by `model_calls_enterprise_idx`. Tokens are summed rather than
   * priced here: a price belongs to a model and a date, and baking today's
   * into a query would make last month's answer wrong the next time a
   * provider changes it.
   */
  async spendFor(enterpriseId: number, since: Date): Promise<ModelSpendRow[]> {
    const rows = await this.query<{
      provider: string;
      model: string;
      purpose: ModelCallPurpose;
      calls: string;
      failed: string;
      unknown: string;
      input_tokens: string | null;
      output_tokens: string | null;
    }>(
      `SELECT provider, model, purpose,
              COUNT(*) AS calls,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed,
              COUNT(*) FILTER (WHERE status = 'unknown') AS unknown,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM model_calls
        WHERE enterprise_id = $1 AND created_at >= $2 AND is_deleted = false
        GROUP BY provider, model, purpose
        ORDER BY COUNT(*) DESC, model`,
      [this.requireEnterprise(enterpriseId), since],
    );

    return rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      purpose: row.purpose,
      calls: Number(row.calls),
      failed: Number(row.failed),
      unknown: Number(row.unknown),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
    }));
  }
  /** One call by its public id, scoped to the business that made it. */
  async findByRef(enterpriseId: number, refId: string): Promise<ModelCallRow | null> {
    const rows = await this.query<ModelCallRow>(
      `SELECT ref_id AS "refId", provider, model, purpose, status,
              prompt_version AS "promptVersion", prompt_hash AS "promptHash",
              turn_refs AS "turnRefs", message_id AS "messageId",
              media_key AS "mediaKey", total_tokens AS "totalTokens",
              duration_ms AS "durationMs", failure_code AS "failureCode",
              created_at AS "createdAt"
         FROM model_calls
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), refId],
    );
    return rows[0] ?? null;
  }

  /**
   * The recent calls, newest first.
   *
   * Served by `model_calls_enterprise_idx`, whose ordering this matches
   * exactly — id included, so two calls in the same millisecond keep a
   * stable order instead of swapping between pages.
   */
  async listRecent(enterpriseId: number, limit: number): Promise<ModelCallRow[]> {
    return this.query<ModelCallRow>(
      `SELECT ref_id AS "refId", provider, model, purpose, status,
              prompt_version AS "promptVersion", prompt_hash AS "promptHash",
              turn_refs AS "turnRefs", message_id AS "messageId",
              media_key AS "mediaKey", total_tokens AS "totalTokens",
              duration_ms AS "durationMs", failure_code AS "failureCode",
              created_at AS "createdAt"
         FROM model_calls
        WHERE enterprise_id = $1 AND is_deleted = false
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [this.requireEnterprise(enterpriseId), Math.min(Math.max(1, limit), 100)],
    );
  }
}
