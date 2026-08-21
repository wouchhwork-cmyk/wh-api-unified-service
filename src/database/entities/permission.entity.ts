import { Column, Entity } from 'typeorm';
import {
  PermissionAction,
  Permission as PermissionCode,
  PermissionResource,
  PermissionScope,
  PermissionStatus,
} from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * schema.md §6 — the global catalogue of grantable actions. Deliberately NOT
 * tenant-scoped: "the same action means the same thing everywhere".
 */
@Entity('permissions')
export class Permission extends PublicEntity {
  /**
   * `<resource>.<action>`. Redundant with the two parts by construction and kept
   * because it is the string every call site uses (`@RequirePermission`, API
   * errors); the service layer DERIVES it from resource + action on write "so
   * they cannot drift".
   */
  @Column({ type: 'varchar', length: 100 })
  code!: PermissionCode;

  @Column({ type: 'varchar', length: 50 })
  resource!: PermissionResource;

  @Column({ type: 'varchar', length: 50 })
  action!: PermissionAction;

  /**
   * The feature this action belongs to; NULL = not feature-gated (e.g.
   * `members.invite`). This column "is what makes feature-level access and
   * action-level access one system instead of two" — without it, flags and
   * permissions would be unrelated systems that can disagree.
   */
  @Column({ type: 'bigint', transformer: bigintTransformer, nullable: true })
  featureId!: number | null;

  @Column({ type: 'varchar', length: 30, default: PermissionScope.Enterprise })
  scope!: PermissionScope;

  /** Shown in the role editor UI. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 30, default: PermissionStatus.Active })
  status!: PermissionStatus;
}
