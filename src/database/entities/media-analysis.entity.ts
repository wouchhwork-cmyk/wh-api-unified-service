import { Column, Entity, Index } from 'typeorm';
import { MediaAnalysisStatus, MediaKind } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';
import { TIMESTAMP_PRECISION } from '../timestamp-precision';

/**
 * What a piece of media was, in words — kept after the media is gone.
 *
 * ONE ROW PER UNIQUE MEDIA PER BUSINESS, enforced by `media_analyses_key_uniq`
 * rather than by the caller remembering. A refreshed CDN link is the same
 * media with a new signature; `mediaKey` is built from what does not change, so
 * the second arrival finds the first row instead of paying Google again.
 *
 * It doubles as a work ledger — status, attempts, lease, backoff — because the
 * analysis is a slow external call that must not sit on the ingestion path.
 */
@Entity('media_analyses')
@Index('media_analyses_key_uniq', ['enterpriseId', 'mediaKey'], { unique: true })
export class MediaAnalysis extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  /**
   * The media's STABLE identity: `asset:<id>` when Meta gave one, otherwise
   * `msg:<platformMessageId>:<sortOrder>`. Both survive a link refresh, which
   * is the entire point — see `mediaKeyFor`.
   */
  @Column({ type: 'varchar', length: 200 })
  mediaKey!: string;

  @Column({ type: 'varchar', length: 20 })
  mediaKind!: MediaKind;

  /** What we believed it was when queued; the analyser may correct it. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  mimeType!: string | null;

  @Column({ type: 'varchar', length: 20, default: MediaAnalysisStatus.Pending })
  status!: MediaAnalysisStatus;

  /** What the media showed, in plain sentences. The thing that survives. */
  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  /** Speech, caption or on-image text, verbatim. Null when there was none. */
  @Column({ type: 'text', nullable: true })
  transcript!: string | null;

  /**
   * WHAT PRODUCED THIS ANSWER. Both are editable from the platform console, so
   * a description that reads oddly has to be traceable to the instruction
   * behind it — which will have moved on by the time anybody asks.
   */
  @Column({ type: 'varchar', length: 80, nullable: true })
  model!: string | null;

  @Column({ type: 'int', nullable: true })
  promptVersion!: number | null;

  @Column({ type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ type: 'int', default: 3 })
  maxAttempts!: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  leaseOwner!: string | null;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  leaseExpiresAt!: Date | null;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  failureCode!: string | null;

  /** Redacted at the call site: a model error can quote the prompt. */
  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  @Column({ type: 'int', nullable: true })
  inputTokens!: number | null;

  @Column({ type: 'int', nullable: true })
  outputTokens!: number | null;

  @Column({ type: 'int', nullable: true })
  totalTokens!: number | null;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  analyzedAt!: Date | null;
}
