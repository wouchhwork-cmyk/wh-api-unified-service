import { Column, Entity } from 'typeorm';
import { Platform, PostKind, PostStatus } from '@/shared/enums';
import { bigintCountTransformer, bigintTransformer } from '../bigint.transformer';
import { PublicEntity } from './base.entity';

/**
 * schema.md §19 — mirrored platform posts. V1 is read-only: the business sees
 * its posts and the comment activity on them. The columns are shaped so that
 * adding publishing later does not require restructuring.
 */
@Entity('posts')
export class Post extends PublicEntity {
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  /** Which surface it was posted on. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  channelId!: number;

  /** Denormalized from the channel, so the tenant-scoped feed needs no join. */
  @Column({ type: 'varchar', length: 30 })
  platform!: Platform;

  @Column({ type: 'varchar', length: 255 })
  platformPostId!: string;

  @Column({ type: 'varchar', length: 30 })
  postKind!: PostKind;

  /** Post text. */
  @Column({ type: 'text', nullable: true })
  caption!: string | null;

  @Column({ type: 'text', nullable: true })
  permalinkUrl!: string | null;

  /**
   * Ordered media descriptors — url, thumbnail, kind, dimensions. JSONB rather
   * than a `post_media` table because in V1 this data is a read-only mirror,
   * never queried by its inner fields and always read whole with its post.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  media!: Record<string, unknown>[];

  /**
   * The engagement counts below get real columns because they are sorted and
   * filtered on. All of them are SNAPSHOTS, not truth — `metricsSyncedAt` says
   * how stale they are, and the UI must show that rather than implying live
   * numbers.
   */
  @Column({ type: 'bigint', default: 0, transformer: bigintCountTransformer })
  likeCount!: number;

  /**
   * The PLATFORM's count, which will not always match the number of `messages`
   * rows we hold — a backfill may be incomplete, or comments may have been
   * deleted at the platform. Never derive one from the other.
   */
  @Column({ type: 'bigint', default: 0, transformer: bigintCountTransformer })
  commentCount!: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintCountTransformer })
  shareCount!: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintCountTransformer })
  viewCount!: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintCountTransformer })
  saveCount!: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintCountTransformer })
  reachCount!: number;

  /** The long tail of platform-specific metrics that have no column. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  metrics!: Record<string, unknown>;

  /** When the counts above were last refreshed. */
  @Column({ type: 'timestamptz', nullable: true })
  metricsSyncedAt!: Date | null;

  /** Set only when WE published it — NULL for every mirrored post. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  authoredByMemberId!: number | null;

  /** When the platform says it went live. */
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  /** Detected as removed at the platform. */
  @Column({ type: 'timestamptz', nullable: true })
  platformDeletedAt!: Date | null;

  @Column({ type: 'varchar', length: 30, default: PostStatus.Published })
  status!: PostStatus;

  /** Last full refresh of the post itself, as opposed to just its metrics. */
  @Column({ type: 'timestamptz', nullable: true })
  syncedAt!: Date | null;
}
