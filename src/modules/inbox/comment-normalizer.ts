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
  /**
   * A platform HANDLE, when the platform gives one. Instagram does; Facebook
   * does not. Kept separate from the display name because it is an identifier
   * the person can be addressed and searched by, not just a label.
   */
  readonly authorHandle: string | null;
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

  /*
   * FACEBOOK'S parent_id IS THE POST for a top-level comment.
   *
   * Taken at face value it made every top-level comment on one post collapse
   * into a single conversation keyed `comment:<postId>` — with the first
   * commenter as its customer and everyone else's comments filed underneath —
   * and, worse, a reply was then POSTed to `<postId>/comments`, which Facebook
   * accepts as a NEW standalone top-level comment. The agent's answer appeared
   * on the post, detached from the person it answered.
   *
   * So parent_id only counts as a parent COMMENT when it is not the post. When
   * post_id is absent there is nothing to compare against, and it is taken as
   * given — the same behaviour as before, and no worse.
   */
  const parentCommentId =
    value.parent_id && value.parent_id !== value.post_id ? value.parent_id : null;

  return {
    comment: {
      commentId: value.comment_id,
      rootCommentId: parentCommentId ?? value.comment_id,
      parentId: parentCommentId,
      postId: value.post_id ?? null,
      text: value.message ?? null,
      // Facebook sends unix SECONDS.
      createdAt: value.created_time ? new Date(value.created_time * 1000) : null,
      authorPlatformId: value.from.id,
      authorName: value.from.name ?? null,
      // Facebook exposes no handle on a comment.
      authorHandle: null,
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
      authorHandle: value.from.username ?? value.username ?? null,
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

/**
 * Facebook's mention change: somebody tagged the Page in their own post or
 * comment. A different vocabulary again — the author is `sender_id`, because the
 * person is not commenting on our content, they are talking about us on theirs.
 */
interface FacebookMentionChange {
  readonly field?: string;
  readonly value?: {
    readonly item?: string;
    readonly verb?: string;
    readonly post_id?: string;
    readonly comment_id?: string;
    readonly sender_id?: string;
    readonly sender_name?: string;
    readonly message?: string;
    readonly created_time?: number;
  };
}

/**
 * Instagram's mentions change carries ids only — `media_id` and `comment_id` —
 * and no author or text at all. Reading the content needs a second Graph call
 * against a different edge, so there is nothing to project from the event alone.
 */
interface InstagramMentionChange {
  readonly field?: string;
  readonly value?: {
    readonly media_id?: string;
    readonly comment_id?: string;
  };
}

/**
 * Normalises a mention onto the SAME canonical shape as a comment.
 *
 * Deliberately shared: a mention and a comment differ in where they were
 * written, not in what the inbox has to do with them — resolve a person, open or
 * find a thread, store one message. Only the conversation kind differs, and that
 * is the caller's decision rather than a second projector.
 */
export function normalizeMention(platform: Platform, payload: unknown): NormalizedComment {
  if (platform === Platform.Instagram) {
    const value = (payload as InstagramMentionChange).value;
    const target = value?.comment_id ?? value?.media_id;
    return {
      skip: target
        ? `instagram mention ${target} carries no author or text — projecting it needs a second graph read`
        : 'the instagram mention names nothing',
    };
  }

  const value = (payload as FacebookMentionChange).value;

  // The mention's identity is the comment when we were tagged in one, otherwise
  // the post. Without one there is nothing to key a message on.
  const mentionId = value?.comment_id ?? value?.post_id;
  if (!mentionId) return { skip: 'the mention names no post or comment' };
  if (isNonProjectingVerb(value?.verb)) {
    return { skip: `mention verb "${value?.verb}" is not projected yet` };
  }
  if (!value?.sender_id) return { skip: 'the mention names no author' };

  return {
    comment: {
      commentId: mentionId,
      // A mention opens its own thread: it is not a reply to our content, so
      // there is no parent comment of ours to hang it under.
      rootCommentId: mentionId,
      parentId: null,
      postId: value.post_id ?? null,
      text: value.message ?? null,
      createdAt: value.created_time ? new Date(value.created_time * 1000) : null,
      authorPlatformId: value.sender_id,
      authorName: value.sender_name ?? null,
      authorHandle: null,
    },
  };
}
