import { Injectable } from '@nestjs/common';
import { PostKind, PostStatus, type Platform } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface UpsertPostInput {
  readonly enterpriseId: number;
  readonly channelId: number;
  readonly platform: Platform;
  readonly platformPostId: string;
  readonly postKind: PostKind;
  readonly caption: string | null;
  readonly permalinkUrl: string | null;
  readonly publishedAt: Date | null;
  readonly commentCount: number | null;
}

@Injectable()
export class PostRepository extends BaseRepository {
  /**
   * Stores a post, or refreshes the one already held.
   *
   * The conflict target is posts_platform_uniq (channel_id, platform_post_id)
   * with NO is_deleted predicate, matching the index exactly: a re-synced post
   * must reuse its row rather than create a second one.
   *
   * COUNTS ARE COALESCED, never overwritten with null: a refresh that did not
   * ask for metrics must not reset a comment count to zero and make the post
   * look untouched. Same reason caption and permalink keep their stored value
   * when the platform omits them.
   */
  async upsert(input: UpsertPostInput): Promise<{ id: number; created: boolean }> {
    const { rows } = await this.mutate<{ id: number; created: boolean }>(
      `INSERT INTO posts
         (enterprise_id, channel_id, platform, platform_post_id, post_kind,
          caption, permalink_url, published_at, comment_count, status, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 0), $10, now())
       ON CONFLICT (channel_id, platform_post_id)
       DO UPDATE SET
         post_kind     = EXCLUDED.post_kind,
         caption       = COALESCE(EXCLUDED.caption, posts.caption),
         permalink_url = COALESCE(EXCLUDED.permalink_url, posts.permalink_url),
         published_at  = COALESCE(EXCLUDED.published_at, posts.published_at),
         comment_count = GREATEST(EXCLUDED.comment_count, posts.comment_count),
         synced_at     = now(),
         updated_at    = now(),
         is_deleted    = false
       RETURNING id, (xmax = 0) AS created`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.channelId,
        input.platform,
        input.platformPostId,
        input.postKind,
        input.caption,
        input.permalinkUrl,
        input.publishedAt,
        input.commentCount,
        PostStatus.Published,
      ],
    );

    const row = rows[0];
    if (!row) throw new Error('post upsert returned no row');
    return { id: Number(row.id), created: row.created };
  }
}
