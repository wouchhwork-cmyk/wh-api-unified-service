import { Check, Column, Entity } from 'typeorm';
import { MIN_ROLE_LEVEL, ROLE_LEVEL, RoleScope, RoleStatus } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/** schema.md §5 — role definitions, enterprise-scoped or staff-scoped. */
@Entity('roles')
/*
 * The level is the whole hierarchy, so the range is a database constraint
 * rather than a convention. A row outside it would silently outrank the owner
 * or silently outrank nothing, and both are escalation bugs that no amount of
 * service-layer care can undo once the row exists.
 */
@Check('roles_level_chk', `level BETWEEN ${MIN_ROLE_LEVEL} AND ${ROLE_LEVEL.Owner}`)
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

  /**
   * How much authority this role carries. HIGHER MEANS MORE, 0 to 100.
   *
   * Three different comparisons hang off this one number, and the difference
   * between them is deliberate (rbac-plan.md §3.1):
   *
   *   see an employee      target <= actor   an agent sees agents
   *   assign a role        role   <  actor   a manager cannot mint a manager
   *   modify an employee   target <  actor   a manager cannot suspend an owner
   *
   * NO DEFAULT, on purpose. Every path that creates a role decides the level
   * explicitly; a default would let a forgotten field mint a role at whatever
   * that default happened to be, which for access control is the wrong kind of
   * convenience.
   */
  @Column({ type: 'smallint' })
  level!: number;
}
