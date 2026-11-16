import { Injectable } from '@nestjs/common';
import type { ModelCallPurpose, ModelCallStatus } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface ModelCallRecord {
  readonly enterpriseId: number;
  readonly provider: string;
  readonly model: string;
  readonly purpose: ModelCallPurpose;
  readonly status: ModelCallStatus;
  readonly messageId?: number | null;
  readonly mediaKey?: string | null;
  readonly promptVersion?: number | null;
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

export interface ModelSpendRow {
  readonly provider: string;
  readonly model: string;
  readonly purpose: ModelCallPurpose;
  readonly calls: number;
  readonly failed: number;
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
   * Records one call.
   *
   * IT NEVER THROWS. This runs after a model call that has already happened
   * — often one that already failed — and a bookkeeping write that took the
   * customer's reply down with it would be a worse bug than the missing row.
   * A failure here is swallowed for the same reason `notifyQueue` swallows
   * its own: the thing that mattered is already done.
   */
  async record(input: ModelCallRecord): Promise<void> {
    try {
      await this.mutate(
        `INSERT INTO model_calls
           (enterprise_id, provider, model, purpose, status, message_id, media_key,
            prompt_version, input_tokens, output_tokens, total_tokens,
            cached_input_tokens, reasoning_tokens, duration_ms, truncated,
            failure_code, failure_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          this.requireEnterprise(input.enterpriseId),
          input.provider,
          input.model,
          input.purpose,
          input.status,
          input.messageId ?? null,
          input.mediaKey ?? null,
          input.promptVersion ?? null,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          input.totalTokens ?? null,
          input.cachedInputTokens ?? null,
          input.reasoningTokens ?? null,
          input.durationMs ?? null,
          input.truncated ?? false,
          input.failureCode ?? null,
          input.failureReason?.slice(0, 500) ?? null,
        ],
      );
    } catch {
      /* Deliberately swallowed — see above. */
    }
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
      input_tokens: string | null;
      output_tokens: string | null;
    }>(
      `SELECT provider, model, purpose,
              COUNT(*) AS calls,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed,
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
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
    }));
  }
}
