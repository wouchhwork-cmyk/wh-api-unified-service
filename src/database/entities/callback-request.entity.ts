import { Column, Entity } from 'typeorm';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * Somebody was told this business would ring them.
 *
 * ITS OWN TABLE, not a note on the conversation. The people who make these
 * calls work from a list of them, and a promise buried in a thread is a
 * promise nobody keeps — which is worse than never having offered.
 *
 * `status` is the point of the row rather than a field on it. Requested,
 * done, or dropped with a reason: a request with no way to close it becomes
 * a list that only grows, and a list that only grows is one nobody reads.
 *
 * ONE OPEN REQUEST PER CONVERSATION, by partial unique index. A customer who
 * asks "did you get that?" a minute later is asking to be reassured, and the
 * obvious reading of it is to make sure — which is a second colleague
 * ringing the same person about the same thing. The prompt asks the model
 * not to; the index is what makes asking unnecessary.
 */
@Entity('callback_requests')
export class CallbackRequest extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  conversationId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  customerId!: number;

  /** The message that asked for it, so whoever rings can read why first. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  messageId!: number | null;

  /**
   * As the customer gave it, and NOT a verified contact.
   *
   * The number comes from somebody typing it in a chat. It is kept here
   * rather than promoted to a verified identifier for the same reason it is
   * recorded self-declared on the customer: nobody checked it.
   */
  @Column({ type: 'varchar', length: 40 })
  phone!: string;

  @Column({ type: 'text' })
  reason!: string;

  /** When they said they could take a call, in their own words. */
  @Column({ type: 'text', nullable: true })
  whenReachable!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'requested' })
  status!: string;

  /** The assistant, or a colleague through the console. */
  @Column({ type: 'varchar', length: 20, default: 'assistant' })
  requestedBy!: string;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  resolutionNote!: string | null;
}
