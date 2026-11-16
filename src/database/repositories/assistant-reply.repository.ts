import { Injectable } from '@nestjs/common';
import { AssistantReplyStatus } from '@/shared/enums';
import { QueueLedgerRepository, type QueueTable } from './queue-ledger.repository';

export interface ClaimedReply {
  readonly id: number;
  readonly enterpriseId: number;
  readonly conversationId: number;
  readonly messageId: number;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

export interface SentReply {
  readonly replyMessageId: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly promptVersion: number | null;
  readonly intent: string | null;
  readonly handoffReason: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

/**
 * The queue of replies the assistant owes.
 *
 * Every method here mirrors `media_analyses`, down to the SQL, because it is
 * the same problem: slow external work that must not run inside the request
 * that caused it, must survive the process that was doing it, and must never
 * be done twice.
 */
@Injectable()
export class AssistantReplyRepository extends QueueLedgerRepository {
  protected readonly table: QueueTable = 'assistant_replies';

  /**
   * Records that a message is owed an answer.
   *
   * IDEMPOTENT ON THE MESSAGE. A redelivered webhook, a retried projection
   * and a worker restarting mid-claim all arrive with the same message id,
   * and exactly one obligation must come out of that — which is the unique
   * index's job, not the caller's.
   *
   * `delayMs` is the pause before it becomes due. People type in bursts, and
   * answering the first of three messages means answering a third of a
   * question. It is stored rather than slept, so a restart keeps it.
   */
  async enqueue(input: {
    enterpriseId: number;
    messageId: number;
    delayMs: number;
  }): Promise<boolean> {
    /*
     * THE CONVERSATION COMES FROM THE MESSAGE, in the same statement.
     *
     * Not to save a round trip — because it makes the row impossible to get
     * wrong. A caller passing both could pass a message from one thread and
     * the id of another, and nothing would notice until an agent opened a
     * conversation and found an answer to something nobody said in it. The
     * SELECT is also the existence check: a message that is not there inserts
     * nothing rather than creating an obligation to answer a ghost.
     */
    const { rows } = await this.mutate<{ id: number }>(
      `INSERT INTO assistant_replies
         (enterprise_id, conversation_id, message_id, next_attempt_at)
       SELECT m.enterprise_id, m.conversation_id, m.id,
              now() + ($3::int * interval '1 millisecond')
         FROM messages m
        WHERE m.enterprise_id = $1 AND m.id = $2 AND m.is_deleted = false
       ON CONFLICT (enterprise_id, message_id) DO NOTHING
       RETURNING id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.messageId,
        Math.max(0, Math.trunc(input.delayMs)),
      ],
    );
    return rows.length > 0;
  }

  /**
   * Claims due work. The mechanics are the base class's; the columns are
   * this queue's own.
   */
  async claimDueBatch(
    leaseOwner: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<ClaimedReply[]> {
    const rows = await this.claimRows<{
      id: number;
      enterprise_id: number;
      conversation_id: number;
      message_id: number;
      attempt_count: number;
      max_attempts: number;
    }>({
      leaseOwner,
      limit,
      leaseSeconds,
      returning: 'id, enterprise_id, conversation_id, message_id, attempt_count, max_attempts',
    });

    return rows.map((row) => ({
      id: Number(row.id),
      enterpriseId: Number(row.enterprise_id),
      conversationId: Number(row.conversation_id),
      messageId: Number(row.message_id),
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
    }));
  }

  /** A reply went out. */
  async markSent(id: number, leaseOwner: string, result: SentReply): Promise<boolean> {
    const { rows } = await this.mutate<{ id: number }>(
      `UPDATE assistant_replies
          SET status = $3, reply_message_id = $4, provider = $5, model = $6,
              prompt_version = $7, intent = $8, handoff_reason = $9,
              input_tokens = $10, output_tokens = $11, total_tokens = $12,
              settled_at = now(), failure_code = NULL, failure_reason = NULL,
              lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL
        WHERE id = $1 AND lease_owner = $2
      RETURNING id`,
      [
        id,
        leaseOwner,
        AssistantReplyStatus.Sent,
        result.replyMessageId,
        result.provider,
        result.model,
        result.promptVersion,
        result.intent,
        result.handoffReason,
        result.inputTokens,
        result.outputTokens,
        result.totalTokens,
      ],
    );
    return rows.length > 0;
  }

  /**
   * Deliberately not answered, and never will be.
   *
   * TERMINAL AND ORDINARY. The switch was off, a colleague got there first,
   * the thread closed, or the model read it and judged that nothing needed
   * saying. None of those is a failure, and filing them as one would bury the
   * handful that are.
   */
  async markSkipped(id: number, leaseOwner: string, reason: string): Promise<boolean> {
    const { rows } = await this.mutate<{ id: number }>(
      `UPDATE assistant_replies
          SET status = $3, skip_reason = $4, settled_at = now(),
              lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL
        WHERE id = $1 AND lease_owner = $2
      RETURNING id`,
      [id, leaseOwner, AssistantReplyStatus.Skipped, reason.slice(0, 40)],
    );
    return rows.length > 0;
  }

  /**
   * A failed attempt, with the settle timestamp this queue keeps.
   *
   * `settled_at` is this table's own column rather than the base's business:
   * a reply that has been given up on is a thing somebody looks for by when
   * it stopped being owed.
   */
  async markFailed(
    id: number,
    leaseOwner: string,
    input: {
      failureCode: string;
      failureReason: string | null;
      permanent: boolean;
      backoffMs: number;
    },
  ): Promise<boolean> {
    return this.failRow(
      id,
      leaseOwner,
      input,
      `,
              settled_at = CASE
                WHEN $5 OR attempt_count >= max_attempts THEN now()
                ELSE NULL
              END`,
    );
  }

  /**
   * Puts the row back without spending an attempt.
   *
   * FOR WAITING, NOT FOR FAILING. Media is described by another worker
   * seconds after it arrives, so a photo sent with no text reaches this queue
   * before there is anything to answer about. That is not a failed attempt —
   * it is a thing that has not happened yet, and charging it against
   * `max_attempts` would write off a perfectly answerable message because a
   * download was slow.
   */
  async defer(id: number, leaseOwner: string, delayMs: number): Promise<boolean> {
    const { rows } = await this.mutate<{ id: number }>(
      `UPDATE assistant_replies
          SET status = $3,
              attempt_count = GREATEST(0, attempt_count - 1),
              next_attempt_at = now() + ($4::int * interval '1 millisecond'),
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND lease_owner = $2
      RETURNING id`,
      [id, leaseOwner, AssistantReplyStatus.Pending, Math.max(0, Math.trunc(delayMs))],
    );
    return rows.length > 0;
  }

  /**
   * Brings waiting rows forward, now that what they were waiting for exists.
   *
   * The poller is the backstop and this is the nudge: a description landing
   * should answer the customer in the second it lands, not at the next tick.
   * Only rows still waiting are moved — one already sent, skipped or given up
   * on is settled, and settled is settled.
   */
  async wake(enterpriseId: number, messageIds: readonly number[]): Promise<number> {
    if (messageIds.length === 0) return 0;
    /*
     * BACK TO WHEN IT WAS CREATED, rather than to `now()`.
     *
     * Two reasons, and the second is the subtle one. It sorts the woken row
     * by how long the customer has actually been waiting rather than by the
     * instant their photo happened to finish downloading. And `now()` rounds
     * to this schema's millisecond precision — UP, not down — so a row
     * written as due "now" sits a fraction in the future and is briefly not
     * claimable (see timestamp-precision.ts). `created_at` is unambiguously
     * in the past by the time anything is waiting on media.
     */
    const { rows } = await this.mutate<{ id: number }>(
      `UPDATE assistant_replies
          SET next_attempt_at = created_at
        WHERE enterprise_id = $1
          AND message_id = ANY($2::bigint[])
          AND status = $3
          AND is_deleted = false
      RETURNING id`,
      [this.requireEnterprise(enterpriseId), [...messageIds], AssistantReplyStatus.Pending],
    );
    return rows.length;
  }
}
