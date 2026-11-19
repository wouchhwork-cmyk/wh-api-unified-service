import { Column, Entity } from 'typeorm';
import { TIMESTAMP_PRECISION } from '../timestamp-precision';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * The two assistant switches for one person, on one connected account.
 *
 * PER CHANNEL AND NOT PER PERSON, which is the whole reason this is a table
 * rather than columns on `customers`. It started as columns, and that made
 * both switches global to a human being: pausing the assistant to type to
 * somebody on Instagram also silenced it on WhatsApp and under every comment
 * they had ever left. "Pause this person" sounds right and means something
 * far wider than anybody taking over one conversation intends.
 *
 * A HANDOFF RAISED IN ONE INBOX IS A FACT ABOUT THAT INBOX. People are
 * reachable in several places, those places are watched by different
 * colleagues on different days, and a business can run two Instagram
 * accounts — `customer_engagements` is channel grain for the same reason.
 * A direct message and a comment on the same account correctly share one
 * flag, because they are the same inbox.
 *
 * ROWS ARE CREATED ON DEMAND. Absent means the ordinary state — nobody
 * waiting, assistant answering — so the overwhelming majority of customers
 * never get a row at all, and reading one that is missing is not an error.
 */
@Entity('customer_assistant_states')
export class CustomerAssistantState extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  customerId!: number;

  /** The connected account this applies to — the inbox somebody is in. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  channelId!: number;

  /**
   * Somebody needs a person here, and nobody has been yet.
   *
   * Raised by the assistant when it hands over, cleared by a colleague who
   * has dealt with it — and the assistant is TOLD which, so a promise of a
   * colleague stops being something it repeats forever.
   */
  @Column({ type: 'boolean', default: false })
  needsHuman!: boolean;

  /** What the assistant said it could not do. The first thing to read. */
  @Column({ type: 'text', nullable: true })
  needsHumanReason!: string | null;

  /** How long they have been waiting, which is the only urgency there is. */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  needsHumanSince!: Date | null;

  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  needsHumanMessageId!: number | null;

  /**
   * When a colleague marked the handoff handled, and who.
   *
   * RECORDED RATHER THAN INFERRED. Without it, "nobody ever needed a person"
   * and "a colleague came and closed it" are the same row — and the
   * assistant, asked to tell them apart from nothing, kept announcing a
   * colleague was still coming after one had been.
   */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  needsHumanResolvedAt!: Date | null;

  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  needsHumanResolvedBy!: number | null;

  /** A colleague is typing here and the assistant is to be quiet. Null = on. */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  automationPausedAt!: Date | null;

  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  automationPausedBy!: number | null;

  /**
   * When it comes back by itself, if anybody said.
   *
   * A pause nobody remembers to lift is an assistant silently off forever,
   * which from outside is indistinguishable from one that is broken.
   */
  @Column({ type: 'timestamptz', precision: TIMESTAMP_PRECISION, nullable: true })
  automationResumesAt!: Date | null;
}
