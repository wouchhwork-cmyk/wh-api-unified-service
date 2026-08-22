import { Column, Entity } from 'typeorm';
import { RoleScope, RoleStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/** schema.md §5 — role definitions, enterprise-scoped or staff-scoped. */
@Entity('roles')
export class Role extends PublicEntity {
  /**
   * NULL = a Wouchh-scoped or template role; set = owned by that business.
   *
   * A NULL-scoped role can never be assigned through `employee_roles`, whose
   * composite FK routes through `enterprise_id` — the correct outcome, because
   * "staff privileges must not arrive through a business employment" (§8).
   */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  enterpriseId!: number | null;

  /**
   * Exists "so a staff role can never be handed to a business employee, or the
   * reverse". Enforced in the service layer at assignment time by checking this
   * value against the target table.
   */
  @Column({ type: 'varchar', length: 30, default: RoleScope.Enterprise })
  scope!: RoleScope;

  @Column({ type: 'varchar', length: 50 })
  name!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string | null;

  /** Seeded by us; a business cannot edit or delete these rows. */
  @Column({ type: 'boolean', default: false })
  isSystem!: boolean;

  @Column({ type: 'varchar', length: 30, default: RoleStatus.Active })
  status!: RoleStatus;
}
