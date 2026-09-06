import { Column, Entity } from 'typeorm';
import {
  EventPriority,
  InboundEventStatus,
  InboundEventType,
  Platform,
  SourceKind,
} from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * schema.md §23 — the inbound half of the transport ledger: one row for every
 * webhook, queue message, cron trigger and provider callback that arrives.
 * Deliberately domain-agnostic, and deliberately WITHOUT `ref_id`: the ledger
 * is internal, never addressed by a client, and a UUID plus its unique index on
 * the highest-volume table in the schema is pure write cost.
 */
@Entity('inbound_events')
export class InboundEvent extends BaseEntity {
  /**
   * Nullable — system-level events have no business. The dedup index wraps this
   * in COALESCE(enterpriseId, 0) so those NULLs still collide, which a plain
   * composite unique index cannot do.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  enterpriseId!: number | null;

  /** NULL for business-level or system events. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  channelId!: number | null;

  @Column({ type: 'varchar', length: 50 })
  sourceKind!: SourceKind;

  /**
   * Id of the source ENTITY as transport names it — a channel id, a Kafka topic,
   * a queue name. A string, not an FK: the source need not be a table row.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  sourceId!: string | null;

  @Column({ type: 'varchar', length: 30 })
  platform!: Platform;

  /**
   * Selects the projector. Backfill and webhooks MUST compose the same
   * eventType for the same item, or an overlapping backfill silently duplicates
   * everything it re-fetches.
   */
  @Column({ type: 'varchar', length: 50 })
  eventType!: InboundEventType;

  @Column({ type: 'varchar', length: 255, nullable: true })
  platformEventId!: string | null;

  /**
   * THE idempotency guard, composed by the ingestion layer and never by the
   * caller: `{platform}:{eventType}:{platformEventId}`, or a canonical payload
   * hash when the platform gives no id.
   */
  @Column({ type: 'varchar', length: 500 })
  dedupKey!: string;

  /** Ties every row in one logical flow together. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  correlationId!: string | null;

  /** The event that caused this one. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  causationId!: string | null;

  /** Distributed-trace id, for stitching to APM spans. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  traceId!: string | null;

  /**
   * Platform ordering token where one exists. With `receivedAt` it lets a
   * consumer reject a stale update that arrives after a newer one — routine
   * with webhooks.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  sourceSequence!: number | null;

  /** Version of the `payload` shape, so replay can still read old rows. */
  @Column({ type: 'smallint', default: 1 })
  schemaVersion!: number;

  /**
   * The raw inbound body exactly as received — everything a projector needs.
   * Holds customer names, handles and message text: NEVER log it wholesale, and
   * its retention window is a privacy commitment.
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload!: Record<string, unknown>;

  /** Original size, recorded even when the body spilled to object storage. */
  @Column({ type: 'int', nullable: true })
  payloadBytes!: number | null;

  /** Object-storage key when the payload exceeded the inline cap. */
  @Column({ type: 'text', nullable: true })
  payloadStorageKey!: string | null;

  /** Transport extras — headers, delivery attempt, signature status. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  /**
   * Dispatch priority, not human triage. Numeric because the claim index orders
   * on it: alphabetical VARCHAR ordering would run `high` before `urgent`.
   * Smaller runs sooner.
   */
  @Column({ type: 'smallint', default: EventPriority.Normal })
  priority!: EventPriority;

  @Column({ type: 'varchar', length: 30, default: InboundEventStatus.Pending })
  status!: InboundEventStatus;

  /** Worker holding the row. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  leaseOwner!: string | null;

  /** Lapse makes the row claimable again — leases are always bounded. */
  @Column({ type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ type: 'int', default: 3 })
  maxAttempts!: number;

  /** Backoff with jitter, so a platform outage does not stampede on recovery. */
  @Column({ type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastErrorAt!: Date | null;

  /** Terminal: an exhausted row stops retrying and waits for an operator. */
  @Column({ type: 'timestamptz', nullable: true })
  deadLetteredAt!: Date | null;

  /** With `processedAt`, the processing-latency metric. */
  @Column({ type: 'timestamptz', nullable: true })
  processingStartedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  /** When the PLATFORM says it happened; with `processedAt` it gives lag. */
  @Column({ type: 'timestamptz', nullable: true })
  receivedAt!: Date | null;
}
