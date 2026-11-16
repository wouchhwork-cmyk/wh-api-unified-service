import { Injectable } from '@nestjs/common';
import { MediaAnalysisStatus, type MediaKind } from '@/shared/enums';
import { QueueLedgerRepository, type QueueTable } from './queue-ledger.repository';

export interface AnalysisSeed {
  readonly mediaKey: string;
  readonly mediaKind: MediaKind;
  readonly mimeType: string | null;
}

export interface ClaimedAnalysis {
  readonly id: number;
  readonly enterpriseId: number;
  readonly mediaKey: string;
  readonly mediaKind: MediaKind;
  readonly mimeType: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

export interface AnalysisResultRow {
  readonly mediaKey: string;
  readonly status: MediaAnalysisStatus;
  readonly summary: string | null;
  readonly transcript: string | null;
  /** The language the media was spoken or written in, when it had one. */
  readonly language: string | null;
  readonly model: string | null;
  readonly analyzedAt: Date | null;
  readonly failureCode: string | null;
}

export interface AnalysisStatRow {
  readonly status: MediaAnalysisStatus;
  readonly mediaKind: MediaKind;
  readonly count: number;
}

/**
 * The media-analysis ledger: one row per unique piece of media, and the queue
 * that gets it described.
 */
@Injectable()
export class MediaAnalysisRepository extends QueueLedgerRepository {
  protected readonly table: QueueTable = 'media_analyses';

  /**
   * Queues media that has not been seen before.
   *
   * ON CONFLICT DO NOTHING against the unique key, which is what makes "once
   * per unique media" true under concurrency. Two webhooks carrying the same
   * asset, or the same message redelivered, both arrive here; the second
   * writes nothing and the first row's eventual answer serves both.
   *
   * Returns how many were genuinely new, so a caller can log the difference
   * between "queued 3" and "saw 3, all already known".
   */
  async enqueueMany(enterpriseId: number, seeds: readonly AnalysisSeed[]): Promise<number> {
    if (seeds.length === 0) return 0;

    const values: unknown[] = [this.requireEnterprise(enterpriseId)];
    const tuples = seeds.map((seed) => {
      const base = values.length;
      values.push(seed.mediaKey, seed.mediaKind, seed.mimeType);
      return `($1, $${base + 1}, $${base + 2}, $${base + 3})`;
    });

    const { rows } = await this.mutate<{ id: number }>(
      `INSERT INTO media_analyses (enterprise_id, media_key, media_kind, mime_type)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (enterprise_id, media_key) DO NOTHING
       RETURNING id`,
      values,
    );
    return rows.length;
  }

  /**
   * Claims due work. The mechanics are the base class's; the columns are
   * this queue's own.
   */
  async claimDueBatch(
    leaseOwner: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<ClaimedAnalysis[]> {
    const rows = await this.claimRows<{
      id: number;
      enterprise_id: number;
      media_key: string;
      media_kind: MediaKind;
      mime_type: string | null;
      attempt_count: number;
      max_attempts: number;
    }>({
      leaseOwner,
      limit,
      leaseSeconds,
      returning: 'id, enterprise_id, media_key, media_kind, mime_type, attempt_count, max_attempts',
    });

    return rows.map((row) => ({
      id: Number(row.id),
      enterpriseId: Number(row.enterprise_id),
      mediaKey: row.media_key,
      mediaKind: row.media_kind,
      mimeType: row.mime_type,
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
    }));
  }

  /**
   * A live link for this media, if one still exists.
   *
   * The analysis row deliberately does NOT store the URL — it expires, and a
   * stored copy would be a stale answer that looks authoritative. The current
   * link is whatever the attachment row holds right now, which the refresh
   * path may have replaced since the job was queued.
   *
   * Newest attachment first: the same media can appear in several messages,
   * and the most recently stored link is the one most likely still alive.
   */
  async findLiveSource(
    enterpriseId: number,
    mediaKey: string,
  ): Promise<{ sourceUrl: string; mimeType: string | null; conversationId: number } | null> {
    const rows = await this.query<{
      sourceUrl: string;
      mimeType: string | null;
      conversationId: number;
    }>(
      `SELECT a.source_url AS "sourceUrl",
              a.mime_type  AS "mimeType",
              m.conversation_id AS "conversationId"
         FROM message_attachments a
         JOIN messages m ON m.id = a.message_id AND m.enterprise_id = a.enterprise_id
        WHERE a.enterprise_id = $1
          AND a.media_key = $2
          AND a.source_url IS NOT NULL
          AND a.is_deleted = false
        ORDER BY a.id DESC
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), mediaKey],
    );
    const row = rows[0];
    return row ? { ...row, conversationId: Number(row.conversationId) } : null;
  }

  /** Writes the answer. The lease guard stops a timed-out worker overwriting. */
  async markDone(
    id: number,
    leaseOwner: string,
    result: {
      summary: string | null;
      transcript: string | null;
      language: string | null;
      model: string;
      promptVersion: number;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
    },
  ): Promise<boolean> {
    const { rows } = await this.mutate<{ id: number }>(
      `UPDATE media_analyses
          SET status = $3, summary = $4, transcript = $5, language = $6,
              model = $7, prompt_version = $8, input_tokens = $9,
              output_tokens = $10, total_tokens = $11, analyzed_at = now(),
              failure_code = NULL, failure_reason = NULL,
              lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL
        WHERE id = $1 AND lease_owner = $2
      RETURNING id`,
      [
        id,
        leaseOwner,
        MediaAnalysisStatus.Done,
        result.summary,
        result.transcript,
        result.language,
        result.model,
        result.promptVersion,
        result.inputTokens,
        result.outputTokens,
        result.totalTokens,
      ],
    );
    return rows.length > 0;
  }

  /**
   * Records a failure, and decides whether it is worth trying again.
   *
   * `permanent` is the caller saying a retry cannot help — an expired link
   * cannot be un-expired, an unsupported file will not become supported. Those
   * go straight to `unavailable` rather than burning two more attempts and a
   * backoff window to reach the same place.
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
    return this.failRow(id, leaseOwner, input);
  }

  /** The analyses for a set of media, for rendering a thread. */
  async findByKeys(enterpriseId: number, keys: readonly string[]): Promise<AnalysisResultRow[]> {
    if (keys.length === 0) return [];
    return this.query<AnalysisResultRow>(
      `SELECT media_key AS "mediaKey", status, summary, transcript, language, model,
              analyzed_at AS "analyzedAt", failure_code AS "failureCode"
         FROM media_analyses
        WHERE enterprise_id = $1 AND media_key = ANY($2::varchar[]) AND is_deleted = false`,
      [this.requireEnterprise(enterpriseId), [...keys]],
    );
  }

  /**
   * The console's counts, PLATFORM-WIDE and so deliberately not tenant-scoped.
   *
   * Every other read in this repository is scoped to one business because it
   * serves that business. This one serves staff watching the pipeline across
   * all of them, which is the one legitimate cross-tenant read here — it
   * returns counts, never content.
   */
  async statsAcrossPlatform(): Promise<AnalysisStatRow[]> {
    const rows = await this.query<{
      status: MediaAnalysisStatus;
      media_kind: MediaKind;
      n: string;
    }>(
      `SELECT status, media_kind, count(*) AS n
         FROM media_analyses
        WHERE is_deleted = false
        GROUP BY status, media_kind
        ORDER BY status, media_kind`,
    );
    return rows.map((row) => ({
      status: row.status,
      mediaKind: row.media_kind,
      count: Number(row.n),
    }));
  }

  /** Token spend to date, so the console can show what the feature costs. */
  async tokenTotals(): Promise<{ analyses: number; totalTokens: number }> {
    const rows = await this.query<{ analyses: string; tokens: string | null }>(
      `SELECT count(*) AS analyses, sum(total_tokens) AS tokens
         FROM media_analyses
        WHERE status = $1 AND is_deleted = false`,
      [MediaAnalysisStatus.Done],
    );
    return {
      analyses: Number(rows[0]?.analyses ?? 0),
      totalTokens: Number(rows[0]?.tokens ?? 0),
    };
  }
}
