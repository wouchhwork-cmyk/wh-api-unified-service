import { Column, Entity } from 'typeorm';
import { ConversationKind, ConversationStatus, Platform } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * schema.md §20 — a thread. A DM conversation, or the comment thread under one
 * post. One conversation per top-level comment thread, not per post, because
 * assignment and status need a grain that means something.
 */
@Entity('conversations')
export class Conversation extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  /** Which surface it happens on. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  channelId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  customerId!: number;

  /**
   * WHICH identifier this thread runs through: a customer with an Instagram id,
   * a Facebook id and a WhatsApp number can hold three simultaneous
   * conversations, and without this you know who is talking but not on which
   * handle — so the reply has nowhere to go.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  customerIdentifierId!: number | null;

  /**
   * The post this thread hangs off — NULL for DMs. Comment threads hang off a
   * real post row instead of a JSONB blob, so "all comments on this post" is an
   * indexed join and the post's own data is not duplicated per thread.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  postId!: number | null;

  /** Denormalized from the channel for tenant-scoped filtering. */
  @Column({ type: 'varchar', length: 30 })
  platform!: Platform;

  @Column({ type: 'varchar', length: 30 })
  conversationKind!: ConversationKind;

  /**
   * The thread key — the platform's own where it has one, otherwise derived,
   * always prefixed by kind (`dm:…`, `comment:…`) so two id spaces cannot
   * collide. NOT NULL is what makes the (channelId, platformThreadId) unique
   * key actually dedup: Meta has no thread object for comments.
   */
  @Column({ type: 'varchar', length: 255 })
  platformThreadId!: string;

  /** Context line: post caption excerpt, story text. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  subject!: string | null;

  /** Link to the originating story or ad, for contexts that are not posts. */
  @Column({ type: 'text', nullable: true })
  contextUrl!: string | null;

  /** Details of a non-post context — ad comments, story replies. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  contextMetadata!: Record<string, unknown>;

  /** Labels for filtering and workflows. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags!: string[];

  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  /** Team employee handling it. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  assignedToEmployeeId!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  assignedAt!: Date | null;

  /** Denormalized for the list view. */
  @Column({ type: 'int', default: 0 })
  messageCount!: number;

  /** Unread inbound messages. */
  @Column({ type: 'int', default: 0 })
  unreadCount!: number;

  /** The inbox's sort key. */
  @Column({ type: 'timestamptz', nullable: true })
  lastMessageAt!: Date | null;

  /** Drives the "waiting on us" views. */
  @Column({ type: 'timestamptz', nullable: true })
  lastInboundAt!: Date | null;

  /** First outbound reply — response-time reporting. */
  @Column({ type: 'timestamptz', nullable: true })
  firstRespondedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'varchar', length: 30, default: ConversationStatus.Open })
  status!: ConversationStatus;
}
