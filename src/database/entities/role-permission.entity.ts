import { Column, Entity } from 'typeorm';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * schema.md §7 — which actions a role grants.
 *
 * No `ref_id`: the join row is never addressed by a client. No tenant column
 * either — "permissions are global, and the role already carries the tenant".
 */
@Entity('role_permissions')
export class RolePermission extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  roleId!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  permissionId!: number;
}
