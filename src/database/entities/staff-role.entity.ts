import { Check, Column, Entity } from 'typeorm';
import { RoleScope } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * Which staff roles one of our own people holds.
 *
 * THE TABLE THAT MAKES `RoleScope.Staff` MEAN SOMETHING (backlog B3). The two
 * staff roles — `support` and `ops` — have been seeded since the beginning and
 * were STRUCTURALLY ungrantable: the only grant table was `employee_roles`,
 * whose `enterprise_id` is NOT NULL behind a composite foreign key, and a staff
 * template has no enterprise. So they sat as two rows nothing could ever point
 * at, while every platform admin got the union of everything they were meant to
 * distinguish.
 *
 * NO `enterprise_id`, and that is the whole point of a separate table rather
 * than a nullable column on the existing one. Staff authority is not scoped to
 * a business — that is what makes it staff authority — and a nullable tenant
 * key on `employee_roles` would have made every tenant-isolation query in the
 * schema say "and this one case is different".
 */
@Entity('staff_roles')
/*
 * The scope is pinned here and the foreign key routes through it, so pairing a
 * staff member with an ENTERPRISE-scoped role cannot be represented. The same
 * trick `employee_roles` uses in the opposite direction.
 */
@Check('staff_roles_scope_chk', `role_scope = '${RoleScope.Staff}'`)
export class StaffRole extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  staffId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  roleId!: number;

  /**
   * Always `staff`. A column rather than a constant because a foreign key can
   * only route through a column — this is the half of the composite key that
   * makes the guarantee the database's rather than the service's.
   */
  @Column({ type: 'varchar', length: 30, default: RoleScope.Staff })
  roleScope!: RoleScope;

  /** Who granted it. NULL for a grant made by provisioning rather than a person. */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  grantedByStaffId!: number | null;
}
