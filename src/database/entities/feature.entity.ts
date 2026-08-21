import { Column, Entity } from 'typeorm';
import { FeatureKey, FeatureStatus } from '@/shared/enums';
import { PublicEntity } from './base.entity';

/**
 * schema.md §9 — the catalogue of product features, seeded by us. Gate 1 of
 * access control ("does the business have this feature?") resolves through
 * `enterprise_features`; this table only names what exists.
 */
@Entity('features')
export class Feature extends PublicEntity {
  /**
   * The stable machine key every permission and config entry refers to. Unique
   * among live rows only — a reusable business identifier, so deleting frees it.
   */
  @Column({ type: 'varchar', length: 50 })
  key!: FeatureKey;

  /** Human label. */
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 30, default: FeatureStatus.Active })
  status!: FeatureStatus;
}
