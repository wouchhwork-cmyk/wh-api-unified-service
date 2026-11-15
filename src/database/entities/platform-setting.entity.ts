import { Column, Entity, Index } from 'typeorm';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * Configuration staff can change without a deploy.
 *
 * PLATFORM-WIDE, with no `enterprise_id`, and that is the distinction worth
 * keeping: this is how OUR product behaves, not a preference a business tunes.
 * A business's own settings live on `enterprises`.
 *
 * VERSIONED, because other rows point at a version of a setting — a media
 * analysis records the `promptVersion` that produced it, and the prompt will
 * have been edited twice by the time somebody asks why an old description
 * reads the way it does.
 */
@Entity('platform_settings')
@Index('platform_settings_key_uniq', ['key'], { unique: true })
export class PlatformSetting extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  key!: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  value!: Record<string, unknown>;

  /** Bumped on every change, so a pointer to "the prompt then" stays honest. */
  @Column({ type: 'int', default: 1 })
  version!: number;

  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  updatedByEmployeeId!: number | null;
}
