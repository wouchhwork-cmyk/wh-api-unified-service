import { IdentifierKind, Platform } from '@/shared/enums';
import { normalizeOptionalText } from '@/shared/utils/normalize';

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
  /**
   * What KIND of thing authorPlatformId is.
   *
   * Normally an app-scoped id the platform issued — a PSID or an IGSID — and
   * the projector derives that from the platform. It is stated here for the one
   * case where the platform gives no id at all: Instagram's `tags` edge, which
   * returns another person's media with a `username` and nothing else. A handle
   * is a weaker identity than an id (it can be changed and reused), so it is
   * recorded AS a handle rather than passed off as an id.
   */
  readonly authorIdentifierKind?: IdentifierKind;
  /**
   * Platform facts with no column of their own — where a mention lives, and
   * whose post it is on. Empty for an ordinary comment.
   */
  readonly metadata?: Record<string, unknown>;
}

/**
 * What Meta did to a comment that already exists.
 *
 * These verbs were INGESTED and then discarded: a ledger row was written, the
 * projector skipped it, and the inbox went on showing a comment the customer had
 * deleted or the business had hidden. The verb is part of the dedup key, so the
 * events did arrive distinctly — nothing was ever done with them.
 */
export type CommentModeration = {
  readonly commentId: string;
  readonly action: 'edited' | 'removed' | 'hidden' | 'unhidden';
  /** The new text, for an edit. Null for everything else. */
  readonly text: string | null;
};

export type NormalizedComment =
  | { readonly comment: CanonicalComment }
  | { readonly moderation: CommentModeration }
  | { readonly skip: string };

/**
 * Meta's verb, as an action on a comment we may already hold.
 *
 * `add` returns null: that is a new comment, not a change to one. Anything
 * unrecognised also returns null and is treated as an addition, which is the
 * behaviour before these existed.
 */
function moderationAction(verb: string | undefined): CommentModeration['action'] | null {
  switch (verb) {
    case 'edited':
    case 'edit':
      return 'edited';
    case 'remove':
    case 'removed':
      return 'removed';
    case 'hide':
      return 'hidden';
    case 'unhide':
      return 'unhidden';
    default:
      return null;
  }
}

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
  /*
   * A CHANGE to a comment, not a new one. Handled before the author check,
   * because a removal carries no `from` at all — which is why these used to be
   * dropped twice over: once by the verb guard, and once by a check for an
   * author that a removal was never going to have.
   */
  const action = moderationAction(value.verb);
  if (action !== null) {
    return {
      moderation: { commentId: value.comment_id, action, text: value.message ?? null },
    };
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

  const action = moderationAction(value.verb);
  if (action !== null) {
    return { moderation: { commentId: value.id, action, text: value.text ?? null } };
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

  /*
   * A COMMENT THAT IS MEDIA CARRIES NO `text` KEY AT ALL.
   *
   * Instagram omits `text` rather than sending it empty when a comment is a
   * GIF, a sticker or a photo — and exposes NO field for the media itself, on
   * anybody's post including our own, on every API version
   * (docs/platform-limitations.md §1.4). So this absence is the ONLY signal
   * that a comment had content we cannot show.
   *
   * Recorded because without it the two cases are indistinguishable downstream,
   * and the inbox rendered a blank line. That is worse than it sounds: a reply
   * to such a comment reads as a non-sequitur, which is exactly how it appeared
   * on live traffic — "@genzrelics is it man ???" answering nothing.
   *
   * `in` rather than a falsy check: an empty string is a comment somebody
   * really did leave empty, which is a different thing from one Meta declined
   * to describe.
   */
  // Spread only when there is something to say, so an ordinary comment carries
  // no empty bag — the same shape the mention path and `store` already expect.
  const noText = !('text' in value);

  return {
    comment: {
      ...(noText ? { metadata: { platformSentNoText: true } } : {}),
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
    /*
     * The fields below come from the BACKFILL, not from the webhook. The
     * `tags` edge returns the tagging media itself — caption, permalink,
     * timestamp and the tagger's handle — which is everything the projector
     * needs, and is why an Instagram mention is no longer a dead end.
     */
    readonly username?: string;
    readonly caption?: string;
    readonly permalink?: string;
    readonly timestamp?: string;
    /**
     * Whose post it is, when the Mentions API told us.
     *
     * Separate from `username` because they are DIFFERENT PEOPLE on a comment
     * mention: somebody can tag us in a comment on a stranger's post, and an
     * inbox that conflates the two attributes the post to the wrong account.
     */
    readonly media_owner_username?: string;
    /**
     * The tagged post and the replies under our mention, as the Mentions API
     * gave them. Carried whole rather than flattened: they describe the THREAD,
     * not the mention, and the projector files them on the conversation.
     */
    readonly mention_media?: Record<string, unknown>;
    readonly mention_replies?: readonly Record<string, unknown>[];
    /**
     * The comment our mention was answering, when it was itself a reply.
     *
     * A tag inside a reply is a fragment — "tell this guy" means nothing
     * without the comment above it — so the thread it belongs to is kept.
     */
    readonly mention_parent?: Record<string, unknown>;
    /** That the mention was a reply, even when the parent is unreadable. */
    readonly mention_parent_id?: string;
    /** Likes on the mention itself, distinct from likes on the post. */
    readonly mention_like_count?: number;
    /** The tagged post's own comment section — the room around the mention. */
    readonly mention_post_comments?: readonly Record<string, unknown>[];
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
    /*
     * THE COMMENT ID WINS when there is one, and it has to.
     *
     * A webhook for a comment mention carries BOTH ids, and keying on the media
     * meant every mention on the same post collapsed onto one identity: tag us
     * twice under one photo and the second mention was discarded as a duplicate
     * of the first. The media id is still the right answer for a CAPTION
     * mention and for the /tags backfill, neither of which carries a comment id.
     */
    const target = value?.comment_id ?? value?.media_id;
    if (!target) return { skip: 'the instagram mention names nothing' };

    /*
     * A HANDLE IS THE ONLY IDENTITY THE tags EDGE OFFERS.
     *
     * The webhook carries a media or comment id and nothing else, which is why
     * a live Instagram mention is still skipped — there is no author and no
     * text to project. The BACKFILL reads /tags, which returns the tagging
     * media with the tagger's username, so those do project.
     *
     * The handle is marked as a handle rather than passed off as an app-scoped
     * id: it can be changed and reused, and a later comment from the same
     * person WILL carry a real IGSID, so the two must be distinguishable.
     */
    if (!value?.username) {
      return {
        skip: `instagram mention ${target} carries no author — the webhook gives none, and only a /tags backfill can supply it`,
      };
    }

    /*
     * WHERE THE MENTION LIVES, kept because the thread cannot show it otherwise.
     *
     * A mention is on somebody else's post, so the agent's first question is
     * "what post, and whose?" — and the permalink is the only way to go and
     * look. None of it has a column of its own, and all of it is lost once the
     * ledger row ages out.
     */
    const metadata: Record<string, unknown> = {};
    if (value.media_id) metadata.mentionedMediaId = value.media_id;
    if (value.comment_id) metadata.mentionedCommentId = value.comment_id;
    if (value.permalink) metadata.postPermalink = value.permalink;
    if (value.media_owner_username) metadata.postOwnerUsername = value.media_owner_username;
    if (value.mention_media) metadata.postDetails = value.mention_media;
    /*
     * The replies under our mention. Kept on the MESSAGE as well as the thread
     * because they are a snapshot: Meta gives no webhook when somebody replies
     * to a mention, so this is what the thread looked like at the one moment we
     * were allowed to read it.
     */
    if (value.mention_replies?.length) metadata.replyThread = value.mention_replies;
    /*
     * The thread this mention sits in. Present only when the mention was a
     * reply AND the comment above it also mentioned us — Meta refuses any other
     * comment outright (docs/platform-limitations.md §1.7), so its absence is a
     * boundary rather than a gap in what we asked for.
     */
    if (value.mention_parent) metadata.mentionParent = value.mention_parent;
    /*
     * Recorded even when `mentionParent` is absent. A tag inside a reply whose
     * parent we cannot read is still a reply, and the inbox has to be able to
     * say so instead of showing the fragment as if it opened the conversation.
     */
    if (value.mention_parent_id) metadata.mentionParentId = value.mention_parent_id;
    /*
     * Zero is a real answer here and must survive: `if (count)` would drop it
     * and make an unliked mention indistinguishable from one Meta refused to
     * count for us.
     */
    if (typeof value.mention_like_count === 'number') {
      metadata.mentionLikeCount = value.mention_like_count;
    }
    /*
     * The wider comment section, kept as a SNAPSHOT with the time we read it.
     * Nothing tells us when a stranger comments on somebody else's post, so
     * without the timestamp there is no way to know how stale this is — and a
     * stale count presented as current is worse than none.
     */
    if (value.mention_post_comments?.length) {
      metadata.postComments = value.mention_post_comments;
      metadata.postCommentsReadAt = new Date().toISOString();
    }

    return {
      comment: {
        commentId: target,
        // A mention opens its own thread: it is somebody else's post, so there
        // is no comment of ours for it to hang under.
        rootCommentId: target,
        parentId: null,
        postId: value.media_id ?? null,
        text: normalizeOptionalText(value.caption ?? null),
        createdAt: parseInstagramTimestamp(value.timestamp),
        authorPlatformId: value.username,
        authorName: value.username,
        authorHandle: value.username,
        authorIdentifierKind: IdentifierKind.InstagramUsername,
        metadata,
      },
    };
  }

  const value = (payload as FacebookMentionChange).value;

  // The mention's identity is the comment when we were tagged in one, otherwise
  // the post. Without one there is nothing to key a message on.
  const mentionId = value?.comment_id ?? value?.post_id;
  if (!mentionId) return { skip: 'the mention names no post or comment' };

  const action = moderationAction(value?.verb);
  if (action !== null) {
    return { moderation: { commentId: mentionId, action, text: value?.message ?? null } };
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
