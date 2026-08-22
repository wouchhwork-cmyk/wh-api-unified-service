import { Column, Entity } from 'typeorm';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * schema.md §8 — which roles a employee holds. No `ref_id`: the grant is managed
 * through the employee and role it joins, never addressed on its own.
 *
 * "This is the table where cross-tenant privilege escalation would happen, so it
 * is prevented structurally": both FKs are composite, routed through
 * `enterprise_id`, so pairing business A's employee with business B's role is
 * unrepresentable. Migrations own those constraints.
 */
@Entity('employee_roles')
export class EmployeeRole extends BaseEntity {
  /**
   * Denormalized from the employee so the composite FKs
   * `(employee_id, enterprise_id)` and `(role_id, enterprise_id)` can exist at all.
   */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  employeeId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  roleId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  grantedByEmployeeId!: number | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  grantedAt!: Date;
}
