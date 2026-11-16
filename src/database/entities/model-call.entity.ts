import { Column, Entity } from 'typeorm';
import { ModelCallPurpose, ModelCallStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * One call this service made to a model.
 *
 * METADATA ONLY. No prompt, no response — both are wrapped around a
 * customer's own words, and a cost record is not a reason to keep a second
 * copy of somebody's conversation.
 */
/*
 * ITS INDEXES LIVE IN schema-objects.ts, not here. Both are ordered DESC and
 * one is partial, and a decorator can express neither — declaring a plainer
 * version here would quietly create a SECOND index that the migration does
 * not have, which is exactly what the schema-parity test exists to catch.
 */
@Entity('model_calls')
export class ModelCall extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'varchar', length: 20 })
  provider!: string;

  @Column({ type: 'varchar', length: 80 })
  model!: string;

  @Column({ type: 'varchar', length: 30 })
  purpose!: ModelCallPurpose;

  @Column({ type: 'varchar', length: 10 })
  status!: ModelCallStatus;

  /** The message this was about, when it was about one. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  messageId!: number | null;

  /** The media this was about, when it was about some. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  mediaKey!: string | null;

  @Column({ type: 'int', nullable: true })
  promptVersion!: number | null;

  @Column({ type: 'int', nullable: true })
  inputTokens!: number | null;

  @Column({ type: 'int', nullable: true })
  outputTokens!: number | null;

  @Column({ type: 'int', nullable: true })
  totalTokens!: number | null;

  /** Cheaper than fresh input, and only some providers report it. */
  @Column({ type: 'int', nullable: true })
  cachedInputTokens!: number | null;

  /** Charged as output and never shown to anybody. */
  @Column({ type: 'int', nullable: true })
  reasoningTokens!: number | null;

  /**
   * Wall clock, measured here rather than reported by the provider.
   *
   * A model that is answering but slowly is a different problem from one that
   * is failing, and nothing else tells them apart until somebody complains.
   */
  @Column({ type: 'int', nullable: true })
  durationMs!: number | null;

  @Column({ type: 'boolean', default: false })
  truncated!: boolean;

  @Column({ type: 'varchar', length: 60, nullable: true })
  failureCode!: string | null;

  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;
}
