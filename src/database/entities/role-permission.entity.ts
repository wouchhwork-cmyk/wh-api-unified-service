import { Column, Entity } from 'typeorm';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * schema.md §7 — which actions a role grants.
 *
 * No `ref_id`: the join row is never addressed by a client.
 *
 * It DOES carry a tenant column, which the original note argued against —
 * "permissions are global, and the role already carries the tenant". True, and
 * beside the point: the column is not there to be read, it is there so the
 * composite FK `(role_id, enterprise_id) → roles (id, enterprise_id)` can
 * exist. Without it this was the one join table where isolation rested
 * entirely on a predicate somebody has to remember to write, while
 * `employee_roles` beside it was protected by the schema itself.
 */
@Entity('role_permissions')
export class RolePermission extends BaseEntity {
  /**
   * Denormalized from the role, so the composite FK can exist at all.
   *
   * NULL for a platform TEMPLATE's grants, because a template role has no
   * tenant either. Not a gap to tidy up later: there is no legal value to put
   * there, and the FK simply does not check a row whose key is partly null.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  enterpriseId!: number | null;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  roleId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  permissionId!: number;
}
