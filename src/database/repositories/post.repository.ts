import { Injectable } from '@nestjs/common';
import { PostKind, PostStatus, type Platform } from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface PostFeedRow {
  readonly id: number;
  readonly refId: string;
  readonly platform: Platform;
  readonly postKind: PostKind;
  readonly caption: string | null;
  readonly permalinkUrl: string | null;
  readonly publishedAt: Date | null;
  readonly commentCount: number;
  readonly likeCount: number;
  readonly shareCount: number;
  readonly media: { url?: string; thumbnailUrl?: string; type?: string } | null;
  readonly status: PostStatus;
  readonly channelRefId: string;
  readonly channelName: string | null;
}

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
  /**
   * Reactions of every type on Facebook, likes on Instagram — what a business
   * means by "likes". Null when this walk did not ask for metrics, which is not
   * the same as zero and must not overwrite what is stored.
   */
  readonly likeCount: number | null;
  /** Facebook only; Instagram exposes no share count on the media edge. */
  readonly shareCount: number | null;
  /**
   * `{ url, thumbnailUrl, type }`, or null when the platform offered no
   * preview. Stored as jsonb because the shape differs per platform and per
   * media kind, and a column per variant would be a migration each time.
   */
  readonly media: { url?: string; thumbnailUrl?: string; type?: string } | null;
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
          caption, permalink_url, published_at, comment_count, like_count, share_count,
          media, status, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 0), COALESCE($10, 0),
               COALESCE($11, 0), COALESCE($12, '{}'::jsonb), $13, now())
       ON CONFLICT (channel_id, platform_post_id)
       DO UPDATE SET
         post_kind     = EXCLUDED.post_kind,
         caption       = COALESCE(EXCLUDED.caption, posts.caption),
         permalink_url = COALESCE(EXCLUDED.permalink_url, posts.permalink_url),
         published_at  = COALESCE(EXCLUDED.published_at, posts.published_at),
         comment_count = GREATEST(EXCLUDED.comment_count, posts.comment_count),
         /*
          * GREATEST for the same reason as comment_count: a walk that did not ask
          * for metrics sends 0, and letting that win would reset a real count to
          * zero and make a popular post look untouched. The trade is that a
          * genuine DECREASE — a retracted like, a deleted comment — is not
          * reflected until the count climbs past its old high water mark, which
          * is the cheaper wrong answer.
          */
         like_count    = GREATEST(EXCLUDED.like_count, posts.like_count),
         share_count   = GREATEST(EXCLUDED.share_count, posts.share_count),
         /*
          * Only overwritten by something non-empty. An Instagram media url
          * expires, so a refresh that returns one must replace the stale one —
          * but a walk that asked for no media must not blank what we hold.
          */
         media         = CASE WHEN EXCLUDED.media = '{}'::jsonb THEN posts.media ELSE EXCLUDED.media END,
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
        input.likeCount,
        input.shareCount,
        input.media === null ? null : JSON.stringify(input.media),
        PostStatus.Published,
      ],
    );

    const row = rows[0];
    if (!row) throw new Error('post upsert returned no row');
    return { id: Number(row.id), created: row.created };
  }

  /**
   * One page of the post feed, newest first.
   *
   * Keyset, not OFFSET: a feed that grows while somebody pages would shift rows
   * under them and repeat or skip items. The tiebreaker is `id`, so the order is
   * total even when two posts share a publish timestamp — which cross-posted
   * content routinely does.
   *
   * NULLS LAST on published_at is a deliberate departure from
   * posts_feed_idx's ordering: a post whose publish time the platform did not
   * give us belongs at the END of a reverse-chronological feed, not the top. The
   * predicate below therefore does the null handling explicitly rather than
   * relying on row comparison, which yields NULL — and so silently drops rows —
   * the moment either side is null.
   */
  async listFeed(input: {
    enterpriseId: number;
    channelId: number | null;
    limit: number;
    cursor: { publishedAt: Date | null; id: number } | null;
  }): Promise<PostFeedRow[]> {
    const params: unknown[] = [this.requireEnterprise(input.enterpriseId), input.limit];
    const filters: string[] = [];

    if (input.channelId !== null) {
      params.push(input.channelId);
      filters.push(`AND p.channel_id = $${params.length}`);
    }
    if (input.cursor) {
      params.push(input.cursor.publishedAt, input.cursor.id);
      const at = `$${params.length - 1}::timestamptz`;
      const id = `$${params.length}`;
      filters.push(
        `AND (
             (${at} IS NOT NULL AND p.published_at IS NOT NULL
                AND (p.published_at, p.id) < (${at}, ${id}))
          OR (${at} IS NOT NULL AND p.published_at IS NULL)
          OR (${at} IS NULL AND p.published_at IS NULL AND p.id < ${id})
        )`,
      );
    }

    return this.query<PostFeedRow>(
      `SELECT p.id,
              p.ref_id             AS "refId",
              p.platform,
              p.post_kind          AS "postKind",
              p.caption,
              p.permalink_url      AS "permalinkUrl",
              p.published_at       AS "publishedAt",
              p.comment_count      AS "commentCount",
              p.media,
              p.like_count         AS "likeCount",
              p.share_count        AS "shareCount",
              p.status,
              c.ref_id             AS "channelRefId",
              c.name               AS "channelName"
         FROM posts p
         JOIN channels c ON c.id = p.channel_id AND c.enterprise_id = p.enterprise_id
        WHERE p.enterprise_id = $1
          AND p.is_deleted = false
          ${filters.join('\n          ')}
        ORDER BY p.published_at DESC NULLS LAST, p.id DESC
        LIMIT $2`,
      params,
    );
  }
}
