import { z } from 'zod';
import type {
  GraphAccountSchema,
  GraphAccountsResponseSchema,
  GraphActorSchema,
  GraphCommentSchema,
  GraphConversationMessageSchema,
  GraphConversationSchema,
  GraphDebugTokenResponseSchema,
  GraphFeedPostSchema,
  GraphGranularScopeSchema,
  GraphInstagramAccountSchema,
  GraphInstagramCommentSchema,
  GraphInstagramMediaSchema,
  GraphInstagramTagSchema,
  GraphInstagramUserProfileSchema,
  GraphMentionedCommentReplySchema,
  GraphMentionedCommentSchema,
  GraphMentionedMediaSchema,
  GraphMeResponseSchema,
  GraphMessageAttachmentSchema,
  GraphPagingSchema,
  GraphTokenResponseSchema,
} from './graph.schemas';

/**
 * The Graph API shapes this integration actually consumes.
 *
 * THE RESPONSE SHAPES ARE INFERRED FROM THE SCHEMAS IN graph.schemas.ts, not
 * declared here. They were declared twice — once as an interface and once as
 * the runtime check — which is two places to disagree about the same wire
 * format, and the disagreement would show up as a cast that compiled and a
 * parse that failed. The schema is the definition; these are its shadow.
 *
 * What remains hand-written below is the DOMAIN shapes — what this codebase
 * makes of a response once it has one. Those are ours, and nothing external
 * can change them.
 *
 * Ported from the socialLift implementation, which runs these calls against the
 * real API in production. Field lists are deliberately minimal: every extra
 * field is one more thing Meta can change under us.
 */

export type GraphTokenResponse = z.infer<typeof GraphTokenResponseSchema>;

export type GraphMeResponse = z.infer<typeof GraphMeResponseSchema>;

/** The linked Instagram professional account, via field expansion. */
export type GraphInstagramAccount = z.infer<typeof GraphInstagramAccountSchema>;

export type GraphAccount = z.infer<typeof GraphAccountSchema>;

export type GraphAccountsResponse = z.infer<typeof GraphAccountsResponseSchema>;

/**
 * debug_token, used only for the New-Page-Experience fallback where
 * /me/accounts comes back empty but the token still carries page grants.
 */
export type GraphGranularScope = z.infer<typeof GraphGranularScopeSchema>;

export type GraphDebugTokenResponse = z.infer<typeof GraphDebugTokenResponseSchema>;

/** What a normalised Page looks like once discovery is done. */
export interface DiscoveredPage {
  readonly pageId: string;
  readonly pageName: string | null;
  readonly pageAccessToken: string | null;
  readonly category: string | null;
  readonly instagramAccountId: string | null;
  readonly instagramUsername: string | null;
  /** Set when this page's detail lookup failed; surfaced, never swallowed. */
  readonly error: string | null;
}

export interface GraphErrorBody {
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly code?: number;
    readonly error_subcode?: number;
    readonly fbtrace_id?: string;
  };
}

export interface SendResult {
  readonly platformId: string;
}

/* ------------------------------------------------------------------ *
 * Read edges, used by backfill. Every field is optional except the id
 * because Graph omits rather than nulls: a post with no text has no
 * `message` key at all, and treating absence as an error would abandon
 * a walk over a photo post.
 * ------------------------------------------------------------------ */

export type GraphPaging = NonNullable<z.infer<typeof GraphPagingSchema>>;

/** Any Graph edge: a page of `data` plus the cursor to continue it. */
export interface GraphEdge<T> {
  data?: T[] | undefined;
  paging?: GraphPaging | undefined;
}

export type GraphActor = z.infer<typeof GraphActorSchema>;

export type GraphComment = z.infer<typeof GraphCommentSchema>;

export type GraphFeedPost = z.infer<typeof GraphFeedPostSchema>;

/**
 * Media on a backfilled message.
 *
 * A DIFFERENT SHAPE from the webhook's, for the same thing: the read edge nests
 * the link under `image_data` / `video_data` / `file_url` and names no type,
 * where a webhook says `{type, payload:{url}}`. The worker translates one into
 * the other so a message recovered by a resync stores exactly what the same
 * message would have stored had its webhook arrived.
 */
/**
 * An Instagram customer's public profile, by their scoped id.
 *
 * A SEPARATE CALL from the conversations edge, which gives an id and a handle
 * and nothing else — no picture, no follower count, and not even the person's
 * real display name, only their handle. Everything here was reachable with the
 * token we already hold and was simply never asked for.
 */
export type GraphInstagramUserProfile = z.infer<typeof GraphInstagramUserProfileSchema>;

export type GraphMessageAttachment = z.infer<typeof GraphMessageAttachmentSchema>;

export type GraphConversationMessage = z.infer<typeof GraphConversationMessageSchema>;

export type GraphConversation = z.infer<typeof GraphConversationSchema>;

/* ------------------------------------------------------------------ *
 * Instagram read edges. A different vocabulary from Facebook's for the
 * same concepts: media rather than posts, `text` rather than `message`,
 * `username` rather than `name`, `timestamp` rather than `created_time`.
 * ------------------------------------------------------------------ */

export type GraphInstagramComment = z.infer<typeof GraphInstagramCommentSchema>;

export type GraphInstagramMedia = z.infer<typeof GraphInstagramMediaSchema>;

/**
 * A post by SOMEONE ELSE that tagged this Instagram account — the `tags` edge.
 *
 * Distinct from a comment mention, which arrives on the `mentions` webhook
 * field: this is the account being tagged in another person's media, and there
 * is no webhook for the ones that happened before the app was connected.
 */
export type GraphInstagramTag = z.infer<typeof GraphInstagramTagSchema>;

/**
 * A mention resolved through the Mentions API.
 *
 * The `mentions` webhook carries two ids and nothing else — no author, no text —
 * so a live mention is unprojectable until these are read back. See
 * docs/platform-limitations.md §1.2.
 */
export type GraphMentionedMedia = z.infer<typeof GraphMentionedMediaSchema>;

export type GraphMentionedCommentReply = z.infer<typeof GraphMentionedCommentReplySchema>;

export type GraphMentionedComment = z.infer<typeof GraphMentionedCommentSchema>;

/** One reply under the comment that mentioned us. */
export interface ResolvedMentionReply {
  readonly platformId: string;
  /**
   * Absent for some replies and no field combination recovers it — a media-only
   * reply has no text to return (docs/platform-limitations.md §1.4).
   */
  readonly text: string | null;
  readonly timestamp: string | null;
  readonly likeCount: number | null;
}

/** What the tagged post will tell us. Counts are absent, never zero, when refused. */
export interface ResolvedMentionMedia {
  readonly id: string | null;
  readonly caption: string | null;
  readonly permalink: string | null;
  readonly ownerUsername: string | null;
  readonly mediaType: string | null;
  readonly mediaUrl: string | null;
  /** Set for video and reels, which carry no mediaUrl at all. */
  readonly thumbnailUrl: string | null;
  /** `FEED`, `REELS`, `STORY` — what KIND of post this is. */
  readonly productType: string | null;
  readonly timestamp: string | null;
  readonly likeCount: number | null;
  readonly commentsCount: number | null;
}

/**
 * The comment our mention was a reply TO, and the rest of that thread.
 *
 * Only obtainable when the parent ALSO mentioned us: `mentioned_comment` on a
 * stranger's comment is refused with `(#10) User is not mentioned in the
 * comment` (docs/platform-limitations.md §1.7).
 */
export interface ResolvedMentionParent {
  readonly commentId: string;
  readonly text: string | null;
  readonly authorUsername: string | null;
  readonly timestamp: string | null;
  readonly likeCount: number | null;
  readonly replies: readonly ResolvedMentionReply[];
}

/** Either edge, flattened to what the projector needs. */
export interface ResolvedMention {
  /** Whoever named us — the commenter, or the caption's author. */
  readonly authorUsername: string;
  /** Their words: the comment text, or the caption they tagged us in. */
  readonly text: string | null;
  /**
   * Likes on THE MENTION ITSELF — not on the post it sits under.
   *
   * Requested from the first version and thrown away before anything could read
   * it, so a mention with two hundred likes looked exactly like one with none.
   * It is the cheapest signal of how much attention a tag is getting.
   */
  readonly likeCount: number | null;
  readonly timestamp: string | null;
  readonly mediaId: string | null;
  readonly permalink: string | null;
  /** Whose post it is. Frequently NOT the person who mentioned us. */
  readonly mediaOwnerUsername: string | null;
  /** Everything the tagged post will tell us. */
  readonly media: ResolvedMentionMedia | null;
  /**
   * Replies under our mention. Readable, but ANONYMOUS: Meta omits the author
   * on every one of them (§1.4), so these carry no username by design rather
   * than by oversight.
   */
  readonly replies: readonly ResolvedMentionReply[];
  /**
   * THAT the mention was a reply, whether or not we can see what it answered.
   *
   * Kept separately from `parent` because the two answer different questions,
   * and conflating them made an agent read a fragment as a whole thought: a tag
   * inside a reply that we cannot resolve still needs to say "this was replying
   * to something", rather than presenting "soo funny man" as an opening line.
   */
  readonly parentCommentId: string | null;
  /**
   * WHAT THE MENTION WAS ANSWERING, when it was itself a reply.
   *
   * Null when the mention is top-level, and ALSO when the parent did not
   * mention us — Meta refuses any other comment with `(#10) User is not
   * mentioned in the comment`, and the post's own comment list does not contain
   * it either (docs/platform-limitations.md §1.7). So null here does not mean
   * "no parent"; `parentCommentId` is what says that.
   */
  readonly parent: ResolvedMentionParent | null;
  /**
   * The tagged post's own comment section — the ROOM around the mention.
   *
   * Anonymous and unanswerable, and capped: it is stored per mention and a
   * viral post is unbounded. Empty when the extra call was refused, which never
   * costs us the mention itself.
   */
  readonly postComments: readonly ResolvedMentionReply[];
}
