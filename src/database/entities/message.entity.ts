import { Column, Entity } from 'typeorm';
import { MessageDirection, MessageKind, MessageStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * schema.md §21 — every DM, comment, reply and internal note. One table for
 * both directions, so rendering a thread is one indexed scan. This is also
 * where the domain layer links to the transport ledger; both link columns live
 * on this side, so dependencies run domain → ledger with no cycle.
 */
@Entity('messages')
export class Message extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  conversationId!: number;

  /** Denormalized: the tenant key every index and composite FK is scoped by. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'varchar', length: 10 })
  direction!: MessageDirection;

  /** Who sent it, for inbound. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  customerId!: number | null;

  /** Which team employee sent it, for outbound. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  sentByEmployeeId!: number | null;

  /** Reply chains of any depth: comment → reply → reply-to-reply. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  parentMessageId!: number | null;

  /** The ledger event this message was projected from. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  inboundEventId!: number | null;

  /**
   * The ledger row delivering this message. Retries live inside one ledger row,
   * so a message keeps one `outboundEventId` across every attempt; only a fresh
   * user-initiated resend creates a new row.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  outboundEventId!: number | null;

  /**
   * The platform's message / comment id. NULL until an outbound send succeeds,
   * and always NULL for internal notes — which is why its unique index is
   * partial rather than the column being NOT NULL: NULL is a legitimate state
   * with two distinct meanings, not a duplicate.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  platformMessageId!: string | null;

  /**
   * Client-supplied on send, so a double-click or an API retry cannot post
   * twice. It stops US sending twice, not the platform accepting twice.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  idempotencyKey!: string | null;

  @Column({ type: 'varchar', length: 30, default: MessageKind.Text })
  messageKind!: MessageKind;

  /** Text content. */
  @Column({ type: 'text', nullable: true })
  body!: string | null;

  /** Denormalized so rendering a list needs no join to the attachments. */
  @Column({ type: 'boolean', default: false })
  hasAttachments!: boolean;

  /** Comments carry likes. */
  @Column({ type: 'int', default: 0 })
  likeCount!: number;

  /** Reactions, read receipts, platform extras. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  /** Has the team read this inbound message. */
  @Column({ type: 'boolean', default: false })
  isRead!: boolean;

  /** Team-only: never sent, and both ledger columns stay NULL. */
  @Column({ type: 'boolean', default: false })
  isInternalNote!: boolean;

  /**
   * Comment moderation. Hiding is reversible where deleting is not, and both
   * are performed through `outbound_events`.
   */
  @Column({ type: 'boolean', default: false })
  isHiddenOnPlatform!: boolean;

  /** When the platform says it was sent. */
  @Column({ type: 'timestamptz', nullable: true })
  platformSentAt!: Date | null;

  /** Detected as removed at the platform. */
  @Column({ type: 'timestamptz', nullable: true })
  platformDeletedAt!: Date | null;

  @Column({ type: 'varchar', length: 30, default: MessageStatus.Delivered })
  status!: MessageStatus;
}
