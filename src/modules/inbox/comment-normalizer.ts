import { Platform } from '@/shared/enums';

/**
 * Facebook sends a FEED change: one shape covering posts, likes, shares and
 * comments, discriminated by `item`.
 */
interface FacebookCommentChange {
  readonly field?: string;
  readonly value?: {
    readonly item?: string;
    readonly verb?: string;
    readonly comment_id?: string;
    readonly parent_id?: string;
    readonly post_id?: string;
    readonly message?: string;
    readonly created_time?: number;
    readonly from?: { readonly id?: string; readonly name?: string };
  };
}

/**
 * Instagram sends a COMMENTS change, and it is a different shape entirely: the
 * comment id is `id` rather than `comment_id`, the text is `text` rather than
 * `message`, the author's handle is `username` rather than `name`, the post is
 * `media.id`, and there is no `item` discriminator because the field already
 * says what this is.
 */
interface InstagramCommentChange {
  readonly field?: string;
  readonly value?: {
    readonly id?: string;
    readonly text?: string;
    readonly parent_id?: string;
    readonly timestamp?: string | number;
    readonly media?: { readonly id?: string };
    readonly from?: { readonly id?: string; readonly username?: string };
    /** Present on the read edge, absent on the webhook. */
    readonly username?: string;
    readonly verb?: string;
  };
}

/** What the projector actually needs, whichever platform it came from. */
export interface CanonicalComment {
  readonly commentId: string;
  /** The top-level comment this belongs to — itself, when it is the root. */
  readonly rootCommentId: string;
  readonly parentId: string | null;
  readonly postId: string | null;
  readonly text: string | null;
  readonly createdAt: Date | null;
  readonly authorPlatformId: string;
  readonly authorName: string | null;
}

export type NormalizedComment = { readonly comment: CanonicalComment } | { readonly skip: string };

/**
 * Turns either platform's comment event into one shape.
 *
 * This exists because the projector previously understood ONLY the Facebook
 * feed shape while the webhook router mapped Instagram's `comments` field to the
 * same event type — so every Instagram comment reached the projector, failed the
 * `item === 'comment'` check, and was skipped as "not a comment". Instagram
 * comments were silently never projected.
 *
 * Branching on `platform` rather than sniffing the payload is deliberate: the
 * webhook envelope already told us which product sent this (`object`), and
 * guessing from keys would misread an Instagram comment that happens to carry a
 * field Facebook also uses.
 */
export function normalizeComment(platform: Platform, payload: unknown): NormalizedComment {
  return platform === Platform.Instagram
    ? normalizeInstagram(payload as InstagramCommentChange)
    : normalizeFacebook(payload as FacebookCommentChange);
}

function normalizeFacebook(change: FacebookCommentChange): NormalizedComment {
  const value = change.value;

  // A feed change covers posts, likes and shares as well as comments. Only a
  // comment projects into the inbox; the rest are skipped explicitly rather
  // than half-handled.
  if (!value || value.item !== 'comment' || !value.comment_id) {
    return { skip: `not a comment (item="${value?.item ?? 'none'}")` };
  }
  if (isNonProjectingVerb(value.verb)) {
    return { skip: `comment verb "${value.verb}" is not projected yet` };
  }
  if (!value.from?.id) {
    return { skip: 'the comment names no author' };
  }

  return {
    comment: {
      commentId: value.comment_id,
      rootCommentId: value.parent_id ?? value.comment_id,
      parentId: value.parent_id ?? null,
      postId: value.post_id ?? null,
      text: value.message ?? null,
      // Facebook sends unix SECONDS.
      createdAt: value.created_time ? new Date(value.created_time * 1000) : null,
      authorPlatformId: value.from.id,
      authorName: value.from.name ?? null,
    },
  };
}

function normalizeInstagram(change: InstagramCommentChange): NormalizedComment {
  const value = change.value;

  if (!value?.id) {
    return { skip: 'the instagram comment carries no id' };
  }
  if (isNonProjectingVerb(value.verb)) {
    return { skip: `comment verb "${value.verb}" is not projected yet` };
  }

  /*
   * An author id is REQUIRED, and Instagram is where this bites: the comments
   * read edge returns `username` by default and only returns `from` when it is
   * asked for. A username is not an identity — it can be changed and reused —
   * so a comment without `from.id` is skipped rather than filed against a
   * customer keyed on a handle that may later belong to someone else.
   */
  if (!value.from?.id) {
    return { skip: 'the instagram comment names no author id' };
  }

  return {
    comment: {
      commentId: value.id,
      rootCommentId: value.parent_id ?? value.id,
      parentId: value.parent_id ?? null,
      postId: value.media?.id ?? null,
      text: value.text ?? null,
      createdAt: parseInstagramTimestamp(value.timestamp),
      authorPlatformId: value.from.id,
      authorName: value.from.username ?? value.username ?? null,
    },
  };
}

/** A removal or a hide is not a new message; those need their own path. */
function isNonProjectingVerb(verb: string | undefined): boolean {
  return verb === 'remove' || verb === 'hide';
}

/**
 * Instagram sends ISO-8601 on the read edge and unix seconds on some webhooks,
 * so both are accepted rather than assuming one and silently storing 1970.
 */
function parseInstagramTimestamp(value: string | number | undefined): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
