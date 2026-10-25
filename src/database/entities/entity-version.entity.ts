import { Column, Entity } from 'typeorm';
import { ActorKind } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * What a piece of configuration looked like, every time it changed.
 *
 * `audit_logs` answers "who changed this, and when". It cannot answer "what did
 * this look like in March", because `changes` holds only the fields a call site
 * chose to name — reconstructing a past state would mean replaying every diff
 * and trusting that none omitted anything. For a reward program, whose
 * configuration decides who receives money, that is not good enough.
 *
 * The two are written together and read together: a version row carries the
 * same `correlation_id` as the audit row from the same request.
 *
 * APPEND-ONLY, by trigger. A history that can be edited is not a history.
 */
@Entity('entity_versions')
export class EntityVersion extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  /** Which table `entityId` points at. Not an FK, for the reason audit_logs is not. */
  @Column({ type: 'varchar', length: 50 })
  entityType!: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  entityId!: number;

  /** 1 for the first version. Unique per entity, enforced by index. */
  @Column({ type: 'int' })
  version!: number;

  /**
   * The whole entity as it stood AFTER this change — never serialised from the
   * row, always stated by the call site.
   *
   * A reward program carries `forward_config`, which holds a credential
   * REFERENCE. Auto-capturing the row would write it into an append-only table
   * that can never give it back, so redaction has to be a deliberate act at
   * each call site rather than a filter somebody remembers to maintain.
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  snapshot!: Record<string, unknown>;

  /** What moved since the previous version. The snapshots remain the authority. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  changeSummary!: Record<string, unknown>;

  /** NULL = the system acted. Same three-column split as audit_logs. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  actorIdentityId!: number | null;

  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  actorEmployeeId!: number | null;

  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  actorStaffId!: number | null;

  @Column({ type: 'varchar', length: 30 })
  actorKind!: ActorKind;

  @Column({ type: 'boolean', default: false })
  isImpersonated!: boolean;

  /** Ties this version to the request that produced it, and so to its audit row. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  correlationId!: string | null;
}
