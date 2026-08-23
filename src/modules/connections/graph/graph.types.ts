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

export interface GraphConversationMessage {
  id: string;
  message?: string;
  created_time?: string;
  from?: GraphActor;
  to?: { data?: GraphActor[] };
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
