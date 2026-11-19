import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';

export interface ToolCallRow {
  readonly refId: string;
  readonly toolName: string;
  readonly effect: string;
  readonly round: number;
  readonly outcome: string;
  readonly because: string | null;
  readonly arguments: Record<string, unknown>;
  readonly result: Record<string, unknown> | null;
  readonly note: string | null;
  readonly durationMs: number | null;
  readonly createdAt: Date;
}

/**
 * The record of what the assistant asked this service to do.
 *
 * WRITE-ONLY ON THE HOT PATH, which is why there is one insert and no
 * update. A tool runs once and is settled by the time anybody writes it
 * down — there is no in-flight state to reconcile, unlike the queues, and a
 * row that can only be written once cannot be corrected into saying
 * something that did not happen.
 */
@Injectable()
export class AssistantToolCallRepository extends BaseRepository {
  /**
   * One finished tool call.
   *
   * NEVER THROWS INTO THE CALLER. Recording is not the work — the work was
   * the tool, and it has already run. A ledger write that fails must not
   * turn a successful lookup into a failed reply, so the caller logs and
   * carries on. That is the one place in this service where losing a record
   * is the better of two bad outcomes, and it is bounded: the effect itself
   * is already recorded by the tool that had one.
   */
  async record(input: {
    enterpriseId: number;
    conversationId: number;
    messageId: number | null;
    modelCallId: number | null;
    toolName: string;
    effect: string;
    round: number;
    outcome: string;
    because: string | null;
    arguments: Record<string, unknown>;
    result: Record<string, unknown> | null;
    note: string | null;
    durationMs: number | null;
  }): Promise<string | null> {
    const rows = await this.query<{ refId: string }>(
      `INSERT INTO assistant_tool_calls
         (enterprise_id, conversation_id, message_id, model_call_id, tool_name, effect,
          round, outcome, because, arguments, result, note, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)
       RETURNING ref_id AS "refId"`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.conversationId,
        input.messageId,
        input.modelCallId,
        input.toolName,
        input.effect,
        input.round,
        input.outcome,
        input.because,
        JSON.stringify(input.arguments),
        input.result === null ? null : JSON.stringify(input.result),
        input.note,
        input.durationMs,
      ],
    );
    return rows[0]?.refId ?? null;
  }

  /**
   * What the assistant has already done in this conversation.
   *
   * Newest first, bounded by the caller. Two readers: a person asking why
   * something happened, and the runner itself asking whether a write has
   * already been made — "have I already requested a callback here" is a
   * question with an answer in this table, and asking it is cheaper than
   * relying on a model to remember.
   */
  async recent(
    enterpriseId: number,
    conversationId: number,
    limit: number,
  ): Promise<ToolCallRow[]> {
    return this.query<ToolCallRow>(
      `SELECT ref_id AS "refId", tool_name AS "toolName", effect, round, outcome,
              because, arguments, result, note, duration_ms AS "durationMs",
              created_at AS "createdAt"
         FROM assistant_tool_calls
        WHERE enterprise_id = $1 AND conversation_id = $2 AND is_deleted = false
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [this.requireEnterprise(enterpriseId), conversationId, limit],
    );
  }
}
