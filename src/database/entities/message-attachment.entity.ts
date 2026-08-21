import { Column, Entity } from 'typeorm';
import { AttachmentStatus, MediaKind } from '@/shared/enums';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * schema.md §22 — media on a message. Stores the platform's CDN link and, once
 * downloaded, our own copy. No `ref_id`: an attachment is always addressed
 * through its message.
 */
@Entity('message_attachments')
export class MessageAttachment extends BaseEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  messageId!: number;

  /** Denormalized, so the download worker's queries stay tenant-scoped. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'varchar', length: 30 })
  mediaKind!: MediaKind;

  /**
   * Platform CDN URL, stored the moment a webhook delivers media. These links
   * EXPIRE, so anything worth keeping is downloaded to our own storage and
   * served from `storageKey` afterwards.
   */
  @Column({ type: 'text', nullable: true })
  sourceUrl!: string | null;

  /** Our own object-storage key; NULL until downloaded. */
  @Column({ type: 'text', nullable: true })
  storageKey!: string | null;

  /** Platform thumbnail — expires with `sourceUrl`. */
  @Column({ type: 'text', nullable: true })
  thumbnailUrl!: string | null;

  /** Our own thumbnail key. */
  @Column({ type: 'text', nullable: true })
  thumbnailKey!: string | null;

  /** Original name if the platform gave one. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  fileName!: string | null;

  /** An external standard with a fixed name, so it keeps `_type`, not `_kind`. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  mimeType!: string | null;

  /**
   * NULL means unknown, so this uses `bigintTransformer` rather than the count
   * transformer: an unknown size must stay NULL, never become 0.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  fileSizeBytes!: number | null;

  @Column({ type: 'int', nullable: true })
  width!: number | null;

  @Column({ type: 'int', nullable: true })
  height!: number | null;

  /** Video / audio duration. */
  @Column({ type: 'int', nullable: true })
  durationMs!: number | null;

  /** Position in a carousel. */
  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  /** Whether our own copy exists. */
  @Column({ type: 'boolean', default: false })
  isDownloaded!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  downloadedAt!: Date | null;

  /** Alt text, sticker pack, platform extras. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 30, default: AttachmentStatus.Active })
  status!: AttachmentStatus;
}
