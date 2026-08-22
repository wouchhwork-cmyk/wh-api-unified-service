import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PostRepository } from '@/database/repositories/post.repository';
import { PostKind, Platform } from '@/shared/enums';
import { normalizeOptionalText } from '@/shared/utils/normalize';
import type { ProjectionOutcome } from './comment-projector.service';

/**
 * The canonical post shape, produced by the backfill worker from either
 * platform's very different vocabulary (`message` vs `caption`,
 * `created_time` vs `timestamp`, `status_type` vs `media_type`).
 */
interface PostUpdatePayload {
  readonly value?: {
    readonly post_id?: string;
    readonly caption?: string | null;
    readonly permalink_url?: string | null;
    readonly published_at?: string | null;
    readonly post_kind?: string | null;
    readonly comment_count?: number | null;
    readonly media?: { url?: string; thumbnailUrl?: string; type?: string } | null;
  };
}

/**
 * Projects a post into the posts table.
 *
 * Posts are NOT conversations: a post has no customer and opens no thread, so
 * this writes one row and nothing else. It exists so that comment threads have
 * something to hang off and so the product can show which post a conversation
 * came from.
 *
 * Kept idempotent by the upsert rather than by a guard here: the same post
 * arrives on every metrics refresh and on every re-walk of a backfill.
 */
@Injectable()
export class PostProjectorService {
  constructor(
    private readonly posts: PostRepository,
    @InjectPinoLogger(PostProjectorService.name) private readonly logger: PinoLogger,
  ) {}

  async project(
    enterpriseId: number,
    channelId: number,
    platform: Platform,
    _inboundEventId: number,
    payload: unknown,
  ): Promise<ProjectionOutcome> {
    const value = (payload as PostUpdatePayload).value;

    if (!value?.post_id) {
      return { projected: false, reason: 'the event names no post' };
    }

    const result = await this.posts.upsert({
      enterpriseId,
      channelId,
      platform,
      platformPostId: value.post_id,
      postKind: toPostKind(value.post_kind, platform),
      caption: normalizeOptionalText(value.caption ?? null),
      permalinkUrl: value.permalink_url ?? null,
      publishedAt: parseTimestamp(value.published_at),
      commentCount: value.comment_count ?? null,
      media: value.media ?? null,
    });

    // No caption: it is the business's own words, but it can still name people.
    this.logger.debug(
      { enterpriseId, channelId, postId: result.id, created: result.created },
      'post projected',
    );

    return { projected: true };
  }
}

/**
 * Maps each platform's type vocabulary onto PostKind.
 *
 * Unknown types fall back to Text rather than being rejected: a post whose kind
 * we cannot name is still a post, and losing it would leave its comments
 * parentless.
 */
function toPostKind(raw: string | null | undefined, platform: Platform): PostKind {
  const value = raw?.toLowerCase() ?? '';

  if (platform === Platform.Instagram) {
    switch (value) {
      case 'image':
        return PostKind.Image;
      case 'video':
        return PostKind.Video;
      case 'carousel_album':
        return PostKind.Carousel;
      case 'reels':
        return PostKind.Reel;
      case 'story':
        return PostKind.Story;
      default:
        return PostKind.Image;
    }
  }

  switch (value) {
    case 'added_photos':
      return PostKind.Image;
    case 'added_video':
      return PostKind.Video;
    case 'shared_story':
      return PostKind.Link;
    case 'mobile_status_update':
    case 'created_note':
    case 'published_story':
      return PostKind.Text;
    default:
      return PostKind.Text;
  }
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
