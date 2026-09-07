/**
 * The Graph API shapes this integration actually consumes.
 *
 * Ported from the socialLift implementation, which runs these calls against the
 * real API in production. Field lists are deliberately minimal: every extra
 * field is one more thing Meta can change under us.
 */

export interface GraphTokenResponse {
  readonly access_token: string;
  readonly token_type?: string;
  /**
   * Seconds. socialLift discarded this; we capture it into
   * provider_connections.token_expires_at so the expiry sweep has something to
   * work with instead of waiting for a 401.
   */
  readonly expires_in?: number;
}

export interface GraphMeResponse {
  readonly id: string;
  readonly name?: string;
}

/** The linked Instagram professional account, via field expansion. */
export interface GraphInstagramAccount {
  readonly id: string;
  readonly username?: string;
}

export interface GraphAccount {
  readonly id: string;
  readonly name?: string;
  /** The PAGE token. Every downstream call for this Page authorises with it. */
  readonly access_token?: string;
  readonly category?: string;
  readonly instagram_business_account?: GraphInstagramAccount;
}

export interface GraphAccountsResponse {
  readonly data?: readonly GraphAccount[];
  readonly paging?: { readonly next?: string; readonly cursors?: { readonly after?: string } };
}

/**
 * debug_token, used only for the New-Page-Experience fallback where
 * /me/accounts comes back empty but the token still carries page grants.
 */
export interface GraphGranularScope {
  readonly scope: string;
  readonly target_ids?: readonly string[];
}

export interface GraphDebugTokenResponse {
  readonly data?: {
    readonly app_id?: string;
    readonly is_valid?: boolean;
    readonly expires_at?: number;
    readonly scopes?: readonly string[];
    readonly granular_scopes?: readonly GraphGranularScope[];
  };
}

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

export interface GraphPaging {
  cursors?: { before?: string; after?: string };
  next?: string;
}

/** Any Graph edge: a page of `data` plus the cursor to continue it. */
export interface GraphEdge<T> {
  data?: T[];
  paging?: GraphPaging;
}

export interface GraphActor {
  id: string;
  name?: string;
  /** Instagram identifies people by handle; Facebook by name. */
  username?: string;
}

export interface GraphComment {
  id: string;
  message?: string;
  created_time?: string;
  from?: GraphActor;
  parent?: { id?: string };
}

export interface GraphFeedPost {
  id: string;
  message?: string;
  story?: string;
  created_time?: string;
  permalink_url?: string;
  /** added_photos / added_video / shared_story / mobile_status_update / ... */
  status_type?: string;
  /** A ready-made preview image, when the post has one. */
  full_picture?: string;
  attachments?: { data?: { type?: string; media?: { image?: { src?: string } } }[] };
  comments?: GraphEdge<GraphComment>;
  /*
   * ENGAGEMENT COUNTS, and each has to be asked for by name.
   *
   * A Page post carries none of them by default, so posts.like_count and
   * posts.share_count sat at their column default of 0 for every Facebook post
   * ever synced — a "top posts" sort over a column nothing writes.
   *
   * `reactions.summary(total_count)` is the count of ALL reaction types, which is
   * what a business means by likes; the individual breakdown would need a
   * request per type. `comments.summary(total_count)` is the platform's own
   * count, deliberately separate from the comments we have actually stored.
   */
  reactions?: { summary?: { total_count?: number } };
  comment_summary?: { summary?: { total_count?: number } };
  shares?: { count?: number };
}

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
export interface GraphInstagramUserProfile {
  id?: string;
  /** The DISPLAY name, which differs from the handle: "genZrelics" vs "genzrelics". */
  name?: string;
  username?: string;
  /** Expires after a few days, so it is a link to refresh, not one to keep. */
  profile_pic?: string;
  follower_count?: number;
  is_verified_user?: boolean;
  /** Whether the customer follows the business — triage signal for an inbox. */
  is_user_follow_business?: boolean;
  is_business_follow_user?: boolean;
}

export interface GraphMessageAttachment {
  id?: string;
  name?: string;
  mime_type?: string;
  image_data?: { url?: string; width?: number; height?: number };
  video_data?: { url?: string; width?: number; height?: number };
  file_url?: string;
}

export interface GraphConversationMessage {
  id: string;
  message?: string;
  created_time?: string;
  from?: GraphActor;
  to?: { data?: GraphActor[] };
  attachments?: GraphEdge<GraphMessageAttachment>;
  /**
   * Present when this message answered one in particular — the same shape the
   * webhook sends. A recovered thread that omitted it came back as a flat list
   * of unrelated lines, which is not what the customer saw when they wrote it.
   */
  reply_to?: { mid?: string; is_self_reply?: boolean };
  /**
   * A reel, post or profile the customer SHARED into the chat.
   *
   * A separate edge from `attachments`, which returns nothing for a share — so
   * a shared reel arrived as a message with empty text and no media, indistinct
   * from a blank line. What it gives is a public instagram.com permalink, which
   * unlike the CDN links does not expire.
   */
  shares?: GraphEdge<{ link?: string; name?: string; description?: string }>;
}

export interface GraphConversation {
  id: string;
  updated_time?: string;
  messages?: GraphEdge<GraphConversationMessage>;
  /**
   * Both sides of the thread, and the ONLY place a name appears.
   *
   * Meta's messaging webhook carries a sender id and nothing else, so a customer
   * first seen through a direct message has no name at all. This edge is how a
   * backfill can know one: Facebook returns `name`, Instagram returns
   * `username`.
   */
  participants?: { data?: GraphActor[] };
}

/* ------------------------------------------------------------------ *
 * Instagram read edges. A different vocabulary from Facebook's for the
 * same concepts: media rather than posts, `text` rather than `message`,
 * `username` rather than `name`, `timestamp` rather than `created_time`.
 * ------------------------------------------------------------------ */

export interface GraphInstagramComment {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  like_count?: number;
  hidden?: boolean;
  /** Only returned when explicitly requested, and required to identify a person. */
  from?: { id?: string; username?: string };
  parent_id?: string;
}

export interface GraphInstagramMedia {
  id: string;
  caption?: string;
  media_type?: string;
  permalink?: string;
  /**
   * A SIGNED CDN url that EXPIRES. Stored for display, never treated as
   * permanent: a thumbnail that 404s months later is expected, which is why the
   * permalink is kept alongside it as the durable way back to the post.
   */
  media_url?: string;
  /** Videos only — media_url is the video itself, which is not a thumbnail. */
  thumbnail_url?: string;
  timestamp?: string;
  comments_count?: number;
  /** Requested explicitly; without it posts.like_count stays at zero. */
  like_count?: number;
  comments?: GraphEdge<GraphInstagramComment>;
}

/**
 * A post by SOMEONE ELSE that tagged this Instagram account — the `tags` edge.
 *
 * Distinct from a comment mention, which arrives on the `mentions` webhook
 * field: this is the account being tagged in another person's media, and there
 * is no webhook for the ones that happened before the app was connected.
 */
export interface GraphInstagramTag {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  permalink?: string;
  timestamp?: string;
  /** The handle of the person whose post this is. */
  username?: string;
  like_count?: number;
  comments_count?: number;
}

/**
 * A mention resolved through the Mentions API.
 *
 * The `mentions` webhook carries two ids and nothing else — no author, no text —
 * so a live mention is unprojectable until these are read back. See
 * docs/platform-limitations.md §1.2.
 */
export interface GraphMentionedMedia {
  id?: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  /** A VIDEO or REEL carries this and NO media_url. */
  thumbnail_url?: string;
  media_product_type?: string;
  permalink?: string;
  /** The POST OWNER's handle, which may be an account we do not manage. */
  username?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

export interface GraphMentionedCommentReply {
  id?: string;
  text?: string;
  timestamp?: string;
  like_count?: number;
}

export interface GraphMentionedComment {
  id?: string;
  /** Set when this comment is itself a REPLY — the thread it belongs to. */
  parent_id?: string;
  text?: string;
  timestamp?: string;
  /** The handle of whoever wrote the comment that named us. */
  username?: string;
  like_count?: number;
  media?: GraphMentionedMedia;
  replies?: { data?: GraphMentionedCommentReply[] };
}

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
}
