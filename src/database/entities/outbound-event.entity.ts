import { Column, Entity } from 'typeorm';
import {
  DestinationKind,
  EventPriority,
  OutboundEventStatus,
  OutboundEventType,
  Platform,
} from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * schema.md §24 — the outbound half of the transport ledger: §23's shape
 * mirrored, minus `sourceKind` / `sourceId` / `receivedAt` /
 * `processingStartedAt` / `processedAt`, which describe arrival and have no
 * meaning for a send. No `ref_id`, for the same reason as §23.
 *
 * A row MUST be inserted in the same transaction as the state change it
 * announces, with the relay polling after commit — transactional outbox
 * semantics. Writing the domain row and publishing outside the transaction
 * loses events whenever the process dies in between.
 */
@Entity('outbound_events')
export class OutboundEvent extends BaseEntity {
  /**
   * Nullable — system-level events have no business. The dedup index wraps this
   * in COALESCE(enterpriseId, 0) so those NULLs still collide.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  enterpriseId!: number | null;

  /** NULL for business-level or system events. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  channelId!: number | null;

  @Column({ type: 'varchar', length: 50 })
  destinationKind!: DestinationKind;

  /**
   * Id of the destination entity as transport names it — a channel id, a topic,
   * a queue name, a webhook target. A string, not an FK.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  destinationId!: string | null;

  @Column({ type: 'varchar', length: 30 })
  platform!: Platform;

  /** Selects the sender AND the write-back handler. */
  @Column({ type: 'varchar', length: 50 })
  eventType!: OutboundEventType;

  /** The inbound ledger row this answers; NULL when unprompted. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  inReplyToEventId!: number | null;

  /** The recipient's platform id — transport addressing, not customer data. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  recipientPlatformId!: string | null;

  /** The platform's id after a successful send; NULL until then. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  platformEventId!: string | null;

  /**
   * Outbound rows key on their CAUSE, not their result:
   * `{platform}:{eventType}:{sourceTable}:{sourceRowId}`. There is no
   * platformEventId until a send succeeds, and hashing the payload would
   * collide two legitimate identical replies ("Thanks!" twice in one thread).
   */
  @Column({ type: 'varchar', length: 200 })
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

  /** Ordering token where one exists — out-of-order detection. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  sourceSequence!: number | null;

  /** Version of the `payload` shape, so replay can still read old rows. */
  @Column({ type: 'smallint', default: 1 })
  schemaVersion!: number;

  /**
   * The body to send. Holds customer-facing text: never log it wholesale, and
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

  /** Transport extras — headers, delivery attempt, response status. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  /**
   * Dispatch priority, not human triage. Numeric because the due-work index
   * orders on it: alphabetical VARCHAR ordering would run `high` before
   * `urgent`. Smaller runs sooner.
   */
  @Column({ type: 'smallint', default: EventPriority.Normal })
  priority!: EventPriority;

  @Column({ type: 'varchar', length: 30, default: OutboundEventStatus.Pending })
  status!: OutboundEventStatus;

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

  /** NULL = send now; a future value = scheduled. */
  @Column({ type: 'timestamptz', nullable: true })
  scheduledAt!: Date | null;

  /** When it was actually delivered. */
  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;
}
