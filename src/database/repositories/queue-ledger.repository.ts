import { BaseRepository } from './base.repository';

/**
 * The tables that are work queues, named once.
 *
 * A TABLE NAME CANNOT BE A BIND PARAMETER — Postgres parameterises values, not
 * identifiers — so the claim below interpolates one. This list is what makes
 * that safe: the name comes from a subclass declaring a literal from this
 * union, never from a caller, a request or a row, and `assertKnown` refuses
 * anything that is not one of these even if a future edit tries.
 */
const QUEUE_TABLES = ['media_analyses', 'assistant_replies'] as const;

export type QueueTable = (typeof QUEUE_TABLES)[number];

/**
 * The four states every queue here shares.
 *
 * Each ledger has its own enum, because each has terminal states of its own —
 * a description is `done`, a reply is `sent` or `skipped`. These four are the
 * ones the mechanics below depend on, and both enums spell them identically.
 * `queue-ledger.spec.ts` asserts that they still do: a divergence would not
 * throw, it would quietly claim nothing, which is the kind of bug that is
 * noticed by a customer rather than by a test.
 */
export const QueueStatus = {
  Pending: 'pending',
  InFlight: 'in_flight',
  Failed: 'failed',
  Unavailable: 'unavailable',
} as const;

export interface QueueFailure {
  readonly failureCode: string;
  readonly failureReason: string | null;
  /** True when retrying would read the same answer. */
  readonly permanent: boolean;
  readonly backoffMs: number;
}

/**
 * The mechanics every work ledger in this service shares.
 *
 * WHAT IS SHARED IS THE MACHINERY, NOT THE RECORD. Each queue keeps its own
 * table, because each row is a different thing with a different lifetime and
 * a different reader: a media description is the permanent record of a photo
 * whose link has died and is read on every thread render; an owed reply is
 * read by conversation and is prunable the moment it settles. One table with
 * a type column and a jsonb payload would trade columns, constraints and
 * per-queue indexes for a saving of exactly one `CREATE TABLE` — and would
 * put ingestion, sends, media and replies behind a single hot claim index.
 *
 * What genuinely was duplicated is this: claiming with a lease, failing with
 * backoff, and returning a lapsed lease to the queue. Three pieces of SQL
 * that have to be exactly right and had been written out twice.
 */
export abstract class QueueLedgerRepository extends BaseRepository {
  /** Declared as a literal by each subclass. Never built from input. */
  protected abstract readonly table: QueueTable;

  /**
   * Claims due work.
   *
   * FOR UPDATE SKIP LOCKED is the whole concurrency story: two workers can
   * never take the same row and neither waits for the other. The ORDER BY
   * mirrors each table's partial due-index, COALESCE included, so a brand-new
   * row does not sort behind every retrying one.
   *
   * THE COMPARISON IS AT THE STORED PRECISION, and that is not a detail.
   * Every timestamp in this schema holds milliseconds, and Postgres ROUNDS to
   * that precision rather than truncating — so a row written with
   * `next_attempt_at = now()`, or one relying on `created_at`, lands up to
   * half a millisecond in the FUTURE and is briefly not matched by a plain
   * `<= now()`. Production rarely notices, because the writer and the claimer
   * are worker ticks apart; tests claiming inside the same millisecond notice
   * constantly, and two in this repository were already made flaky by it
   * (see timestamp-precision.ts).
   *
   * Rounding the right-hand side the same way makes "due now" mean it. The
   * predicate stays a constant comparison, so the partial index is still
   * used.
   */
  protected async claimRows<T>(input: {
    leaseOwner: string;
    limit: number;
    leaseSeconds: number;
    /** The columns this queue needs back, as written in its own SELECT. */
    returning: string;
  }): Promise<T[]> {
    const table = this.assertKnown(this.table);
    const { rows } = await this.mutate<T>(
      `UPDATE ${table}
          SET status = $1,
              lease_owner = $2,
              lease_expires_at = now() + ($3::int * interval '1 second'),
              attempt_count = attempt_count + 1
        WHERE id IN (
          SELECT id FROM ${table}
           WHERE status IN ($4, $5)
             AND is_deleted = false
             AND COALESCE(next_attempt_at, created_at) <= now()::timestamptz(3)
           ORDER BY COALESCE(next_attempt_at, created_at), id
           LIMIT $6
           FOR UPDATE SKIP LOCKED
        )
      RETURNING ${input.returning}`,
      [
        QueueStatus.InFlight,
        input.leaseOwner,
        input.leaseSeconds,
        QueueStatus.Pending,
        QueueStatus.Failed,
        input.limit,
      ],
    );
    return rows;
  }

  /**
   * Records a failure, and decides whether it is worth trying again.
   *
   * The attempt was already counted by the claim, so `attempt_count >=
   * max_attempts` here means this was the last one.
   */
  protected async failRow(
    id: number,
    leaseOwner: string,
    input: QueueFailure,
    /** Extra assignments this queue makes when it gives up, if any. */
    extraOnSettle = '',
  ): Promise<boolean> {
    const table = this.assertKnown(this.table);
    const { rows } = await this.mutate<{ id: number }>(
      `UPDATE ${table}
          SET status = CASE
                WHEN $5 OR attempt_count >= max_attempts THEN $6
                ELSE $7
              END,
              failure_code = $3,
              failure_reason = $4,
              next_attempt_at = CASE
                WHEN $5 OR attempt_count >= max_attempts THEN NULL
                ELSE now() + ($8::int * interval '1 millisecond')
              END,
              lease_owner = NULL,
              lease_expires_at = NULL${extraOnSettle}
        WHERE id = $1 AND lease_owner = $2
      RETURNING id`,
      [
        id,
        leaseOwner,
        input.failureCode,
        input.failureReason,
        input.permanent,
        QueueStatus.Unavailable,
        QueueStatus.Failed,
        Math.max(0, Math.trunc(input.backoffMs)),
      ],
    );
    return rows.length > 0;
  }

  /**
   * Returns rows whose lease has lapsed to the queue.
   *
   * AS FAILED RATHER THAN PENDING, so the row keeps the attempt it spent. A
   * job whose worker died mid-call has genuinely been tried, and a lease that
   * kept lapsing would otherwise retry it for ever.
   */
  async reclaimExpiredLeases(): Promise<number> {
    const table = this.assertKnown(this.table);
    const { rows } = await this.mutate<{ id: number }>(
      `UPDATE ${table}
          SET status = $1, lease_owner = NULL, lease_expires_at = NULL
        WHERE status = $2 AND lease_expires_at IS NOT NULL AND lease_expires_at < now()
      RETURNING id`,
      [QueueStatus.Failed, QueueStatus.InFlight],
    );
    return rows.length;
  }

  /**
   * The last gate before an identifier reaches SQL.
   *
   * The type system already says this cannot be anything else; this is what
   * holds on the day somebody widens the type, casts around it, or builds a
   * subclass from a config value. One line, and the interpolation above is
   * defensible rather than merely conventional.
   */
  private assertKnown(table: string): QueueTable {
    const known = QUEUE_TABLES.find((candidate) => candidate === table);
    if (!known) throw new Error('a queue ledger named a table that is not a queue');
    return known;
  }
}
