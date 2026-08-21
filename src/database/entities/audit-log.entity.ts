import { Column, Entity } from 'typeorm';
import { ActorKind, AuditAction, AuditEntityType, AuditStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * schema.md §25 — append-only activity log. The service layer only ever
 * INSERTs, and the database backs that up: `UPDATE` and `DELETE` are revoked
 * from the application role. No `ref_id`: nothing addresses a log row by a
 * public identifier.
 *
 * Two inherited columns are here on purpose, and neither is working state:
 *
 * - `updatedAt` is a TAMPER TRIPWIRE. On every legitimate row it equals
 *   `createdAt` forever, so `WHERE updatedAt <> createdAt` cheaply surfaces any
 *   write that bypassed the service layer — a manual UPDATE, a bad migration, a
 *   compromised credential. It is evidence, not state.
 * - `isDeleted` is kept for REPOSITORY-PATTERN CONSISTENCY, so the shared base
 *   repository, its default scope and the common row type all apply here with no
 *   special case. Nothing in the audit path ever sets it.
 */
@Entity('audit_logs')
export class AuditLog extends BaseEntity {
  /** NULL for platform-level events. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  enterpriseId!: number | null;

  /**
   * The actor is split across three columns because "who did this" has three
   * genuinely different answers, and collapsing them loses the distinction that
   * matters most: a Wouchh employee acting on a customer's data must be
   * distinguishable from the customer's own staff doing the same thing.
   *
   * The human who acted; NULL = system / cron / webhook.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  actorIdentityId!: number | null;

  /** The membership they acted through — the business context. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  actorMemberId!: number | null;

  /** Set when a Wouchh person acted — the platform context. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  actorStaffId!: number | null;

  @Column({ type: 'varchar', length: 30 })
  actorKind!: ActorKind;

  /**
   * Wouchh staff acting inside a business's account — the case a customer is
   * entitled to ask about.
   */
  @Column({ type: 'boolean', default: false })
  isImpersonated!: boolean;

  @Column({ type: 'varchar', length: 50 })
  action!: AuditAction;

  @Column({ type: 'varchar', length: 50 })
  entityType!: AuditEntityType;

  /** PK of the affected row. Not an FK: it points at whichever table. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  entityId!: number | null;

  /** Before/after diff — NEVER credentials, NEVER PII. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  changes!: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  @Column({ type: 'inet', nullable: true })
  ipAddress!: string | null;

  @Column({ type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ type: 'varchar', length: 30, default: AuditStatus.Success })
  status!: AuditStatus;
}
