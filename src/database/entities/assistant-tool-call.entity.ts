import { Column, Entity } from 'typeorm';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * What the assistant asked this service to DO, and what came of it.
 *
 * `model_calls` answers what we paid for and what the model said. It cannot
 * answer why this customer has a callback booked, or who decided somebody's
 * name was Priya — those are decisions a model made on a business's behalf,
 * and they need a row of their own.
 *
 * ADDRESSABLE, unlike the queue ledgers: a tool call is something a person
 * asks about ("why was I rung?"), so it carries a ref_id to be asked about
 * by. The queues are internal and deliberately do not.
 *
 * The indexes live in schema-objects.ts, with everything else that is not a
 * CREATE TABLE — declaring them here as well would build a second index of
 * the same name and a slightly different shape, which is drift the parity
 * test exists to catch.
 */
@Entity('assistant_tool_calls')
export class AssistantToolCall extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  conversationId!: number;

  /** The inbound message being answered. Null for a draft somebody asked for. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  messageId!: number | null;

  /** The call that asked, so a tool and its reasoning can be read together. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  modelCallId!: number | null;

  @Column({ type: 'varchar', length: 60 })
  toolName!: string;

  /** read or write. Stored rather than looked up: a tool's effect can change. */
  @Column({ type: 'varchar', length: 10 })
  effect!: string;

  /**
   * Which round of the loop this was.
   *
   * A model that looks something up and then acts on it produces two rows,
   * and the order is the story — without it they are two unrelated things
   * that happened to the same customer in the same second.
   */
  @Column({ type: 'smallint', default: 1 })
  round!: number;

  @Column({ type: 'varchar', length: 20 })
  outcome!: string;

  /**
   * Why it asked, in its own words.
   *
   * The same sentence that is handed back to the next call with the result.
   * A ledger of effects without reasons is a list of things that happened to
   * a customer.
   */
  @Column({ type: 'text', nullable: true })
  because!: string | null;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  arguments!: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;

  /** Why it did not work, in the words the model was given. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'integer', nullable: true })
  durationMs!: number | null;
}
