import { Column, Entity } from 'typeorm';
import { SyncJobKind, SyncJobStatus, SyncTriggerKind } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * schema.md §15 — resumable backfill and refresh work for a channel. Connecting
 * an account is not one API call: it is a long, paged, rate-limited walk through
 * history that must survive restarts. This is a stateful walk, not a ledger row —
 * the individual API calls it makes are still recorded as `outbound_events`.
 */
@Entity('sync_jobs')
export class SyncJob extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  channelId!: number;

  @Column({ type: 'varchar', length: 50 })
  jobKind!: SyncJobKind;

  @Column({ type: 'varchar', length: 30 })
  triggerKind!: SyncTriggerKind;

  @Column({ type: 'varchar', length: 30, default: SyncJobStatus.Pending })
  status!: SyncJobStatus;

  /**
   * WHO this job is about, when it is about one person.
   *
   * The Instagram- or Page-scoped id, passed to the conversations edge as
   * `user_id`. NULL for a channel-wide walk, which is most jobs. It is part of
   * the live-uniqueness rule, so two customers' resyncs never collide while a
   * second channel-wide walk of the same kind still cannot be queued.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  targetPlatformId!: string | null;

  /**
   * The platform's paging cursor — where to resume. Deliberately opaque TEXT:
   * every platform's cursor format is different and none should be parsed.
   */
  @Column({ type: 'text', nullable: true })
  pageCursor!: string | null;

  /** Oldest record this job should fetch. */
  @Column({ type: 'timestamptz', nullable: true })
  windowStartAt!: Date | null;

  /** Newest record this job should fetch. */
  @Column({ type: 'timestamptz', nullable: true })
  windowEndAt!: Date | null;

  /** Progress, for the UI — a human is watching a "connecting your account" screen. */
  @Column({ type: 'int', default: 0 })
  syncedItemCount!: number;

  /** Set only if the platform reports a total; NULL when unknown. */
  @Column({ type: 'int', nullable: true })
  expectedItemCount!: number | null;

  /** Worker holding this job. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  leaseOwner!: string | null;

  /** Lease lapse — a dead worker releases the job without any external reaper. */
  @Column({ type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;

  /** Honour the platform's backoff before resuming. */
  @Column({ type: 'timestamptz', nullable: true })
  rateLimitedUntil!: Date | null;

  @Column({ type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ type: 'int', default: 5 })
  maxAttempts!: number;

  /** Backoff with jitter. */
  @Column({ type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastErrorAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  /** Terminal — attempts are exhausted and no further work is scheduled. */
  @Column({ type: 'timestamptz', nullable: true })
  deadLetteredAt!: Date | null;
}
