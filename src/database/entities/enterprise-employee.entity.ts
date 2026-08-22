import { Column, Entity } from 'typeorm';
import { EmployeeKind, EmployeeStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * schema.md §3 — one row per person per business. The tenant-scoped identity
 * every other table's foreign keys point at, so all of them stay correctly
 * tenant-scoped.
 *
 * There is deliberately no `role` column: roles live in `employee_roles`, so
 * "what can this person do" has exactly one answer.
 */
@Entity('enterprise_employees')
export class EnterpriseEmployee extends PublicEntity {
  /** Which human. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  identityId!: number;

  /** Which business. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  /**
   * `staff` is how a Wouchh person scoped to specific businesses is
   * represented: they reuse the entire employment and permission path, so
   * tenant scoping is enforced in one place rather than two.
   */
  @Column({ type: 'varchar', length: 30, default: EmployeeKind.Business })
  employeeKind!: EmployeeKind;

  @Column({ type: 'varchar', length: 30, default: EmployeeStatus.Invited })
  status!: EmployeeStatus;

  /** Who added them. Self-referential: another employment in the same business. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  invitedByEmployeeId!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  invitedAt!: Date | null;

  /** When the employment became active. */
  @Column({ type: 'timestamptz', nullable: true })
  joinedAt!: Date | null;

  /** Last activity **in this business** — not account-wide. */
  @Column({ type: 'timestamptz', nullable: true })
  lastActiveAt!: Date | null;
}
