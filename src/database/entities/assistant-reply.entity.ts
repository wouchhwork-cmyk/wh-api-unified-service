import { Column, Entity, Index } from 'typeorm';
import { AssistantReplyStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';
import { TIMESTAMP_PRECISION } from '../timestamp-precision';

/**
 * One reply the assistant owes somebody.
 *
 * A work ledger, not a message: the reply itself is a row in `messages`, and
 * `replyMessageId` points at it. What this holds is the OBLIGATION — which
 * survives a worker that dies mid-thought, and which is the whole reason the
 * table exists.
 */
@Entity('assistant_replies')
@Index('assistant_replies_message_uniq', ['enterpriseId', 'messageId'], { unique: true })
export class AssistantReply extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  conversationId!: number;

  /** The inbound message that is owed an answer. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  messageId!: number;

  @Column({ type: 'varchar', length: 20, default: AssistantReplyStatus.Pending })
  status!: AssistantReplyStatus;

  /** Why it was deliberately not answered, when it was not. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  skipReason!: string | null;

  /** The message that answered it. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  replyMessageId!: number | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  provider!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  model!: string | null;

  @Column({ type: 'int', nullable: true })
  promptVersion!: number | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  intent!: string | null;

  /** Why a colleague was asked for, when one was. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  handoffReason!: string | null;

  @Column({ type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ type: 'int', default: 3 })
  maxAttempts!: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  leaseOwner!: string | null;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  leaseExpiresAt!: Date | null;

  /**
   * When it becomes due.
   *
   * Set a moment ahead at enqueue, because people type in bursts and
   * answering the first of three messages means answering a third of a
   * question. It was a `setTimeout` before this column existed, which a
   * restart dropped along with the reply.
   */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  failureCode!: string | null;

  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  @Column({ type: 'int', nullable: true })
  inputTokens!: number | null;

  @Column({ type: 'int', nullable: true })
  outputTokens!: number | null;

  @Column({ type: 'int', nullable: true })
  totalTokens!: number | null;

  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  settledAt!: Date | null;
}
