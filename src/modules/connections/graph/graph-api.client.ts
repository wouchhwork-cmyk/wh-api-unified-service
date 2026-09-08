import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '@/config';
import {
  PLATFORM_REQUEST_TIMEOUT_MS,
  SYNC_COMMENTS_PER_POST,
  SYNC_MESSAGES_PER_CONVERSATION,
  MENTION_POST_COMMENTS_KEPT,
  SYNC_PAGE_SIZE,
} from '@/shared/constants';
import { Platform } from '@/shared/enums';
import { GraphApiError } from './graph-api.error';
import type {
  GraphAccountsResponse,
  GraphConversation,
  GraphDebugTokenResponse,
  GraphEdge,
  GraphFeedPost,
  GraphInstagramMedia,
  GraphInstagramTag,
  GraphMentionedComment,
  GraphMentionedCommentReply,
  GraphMentionedMedia,
  ResolvedMention,
  ResolvedMentionMedia,
  ResolvedMentionParent,
  ResolvedMentionReply,
  GraphMeResponse,
  GraphTokenResponse,
  SendResult,
  GraphInstagramUserProfile,
} from './graph.types';

/**
 * The webhook fields this app subscribes a Page to.
 *
 * INSTAGRAM'S OWN FIELDS ARE HERE TOO, and were missing. A Page subscription
 * covers the Instagram account linked to it, but only for the fields named — so
 * `comments`, `mentions` and `messaging_postbacks` for Instagram were never
 * subscribed, and Instagram comments arrived only through whatever the `feed`
 * field happened to carry. Named as a constant rather than inline because it is
 * a policy, and because the read-back in listSubscribedFields compares against
 * it.
 */
export const SUBSCRIBED_FIELDS = [
  'messages',
  'messaging_postbacks',
  'messaging_optins',
  'feed',
  'mention',
  // Instagram, delivered through the linked Page.
  'comments',
  'mentions',
] as const;

const GRAPH_HOST = 'https://graph.facebook.com';
const DIALOG_HOST = 'https://www.facebook.com';

/**
 * A thin typed client over the Graph API.
 *
 * The call shapes here are ported from the socialLift implementation, which
 * exercises them against the live API in production — the endpoints, parameter
 * names and field expansions are deliberately identical.
 *
 * Two rules that are not negotiable:
 *   - EVERY call carries appsecret_proof. Meta requires it once the app enables
 *     the setting, and it binds the call to our app secret.
 *   - NOTHING logs a URL, a token, or a proof. socialLift logged all three in
 *     cleartext; on a hosted platform those go straight to the log drain.
 */
@Injectable()
export class GraphApiClient {
  constructor(private readonly config: AppConfigService) {}

  private get version(): string {
    return this.config.meta.graphApiVersion;
  }

  /**
   * The Facebook Login for Business dialog.
   *
   * There is deliberately NO `scope` parameter: permissions come from the
   * `config_id` configuration in the Meta App Dashboard. Adding a scope list
   * here would conflict with it.
   */
  buildLoginDialogUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.meta.appId,
      redirect_uri: this.config.meta.oauthRedirectUri,
      config_id: this.config.meta.loginConfigId,
      response_type: 'code',
      state,
    });
    return `${DIALOG_HOST}/${this.version}/dialog/oauth?${params.toString()}`;
  }

  /** Step 1: the authorization code becomes a short-lived user token. */
  async exchangeCodeForToken(code: string): Promise<GraphTokenResponse> {
    // No access token yet, so this one call cannot carry appsecret_proof.
    return this.request<GraphTokenResponse>('GET', 'oauth/access_token', {
      params: {
        client_id: this.config.meta.appId,
        client_secret: this.config.meta.appSecret,
        redirect_uri: this.config.meta.oauthRedirectUri,
        code,
      },
      skipProof: true,
    });
  }

  /**
   * Step 2: the short-lived token becomes a long-lived one.
   *
   * `expires_in` from this response is what we persist. socialLift threw it
   * away, which left no way to know a token was dying until a call failed.
   */
  async exchangeForLongLivedToken(shortLivedToken: string): Promise<GraphTokenResponse> {
    return this.request<GraphTokenResponse>('GET', 'oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: this.config.meta.appId,
        client_secret: this.config.meta.appSecret,
        fb_exchange_token: shortLivedToken,
      },
      skipProof: true,
    });
  }

  async getMe(accessToken: string): Promise<GraphMeResponse> {
    return this.request<GraphMeResponse>('GET', 'me', {
      accessToken,
      params: { fields: 'id,name' },
    });
  }

  /**
   * Page discovery in ONE call, using field expansion to bring the linked
   * Instagram account with it.
   *
   * socialLift called /me/accounts and then re-fetched every page individually;
   * this asks for the same data once. The expansion
   * `instagram_business_account{id,username}` is the trick that makes Instagram
   * discovery free — there is no separate "list my Instagram accounts" endpoint.
   */
  async listAccountsWithInstagram(
    userAccessToken: string,
    after?: string,
  ): Promise<GraphAccountsResponse> {
    return this.request<GraphAccountsResponse>('GET', 'me/accounts', {
      accessToken: userAccessToken,
      params: {
        fields: 'id,name,access_token,category,instagram_business_account{id,username}',
        limit: '100',
        ...(after ? { after } : {}),
      },
    });
  }

  /**
   * The New-Page-Experience fallback: when /me/accounts is empty, the grant may
   * still name its target pages in granular_scopes. Uses an APP access token
   * (`{appId}|{appSecret}`), which is what debug_token requires.
   */
  async debugToken(inputToken: string): Promise<GraphDebugTokenResponse> {
    return this.request<GraphDebugTokenResponse>('GET', 'debug_token', {
      params: {
        input_token: inputToken,
        access_token: `${this.config.meta.appId}|${this.config.meta.appSecret}`,
      },
      skipProof: true,
    });
  }

  /** Per-page lookup, used only by the fallback path. */
  async getPageWithInstagram(
    pageId: string,
    userAccessToken: string,
  ): Promise<{
    id: string;
    name?: string;
    access_token?: string;
    category?: string;
    instagram_business_account?: { id: string; username?: string };
  }> {
    return this.request('GET', pageId, {
      accessToken: userAccessToken,
      params: { fields: 'id,name,access_token,category,instagram_business_account{id,username}' },
    });
  }

  /**
   * Subscribes a Page to our webhook fields. Without this the app receives
   * nothing for that Page, however correct the app-level subscription is.
   */
  async subscribePageToApp(pageId: string, pageAccessToken: string): Promise<void> {
    await this.request('POST', `${pageId}/subscribed_apps`, {
      accessToken: pageAccessToken,
      // Body, not query string: socialLift put these in the URL, which works but
      // logs message content and is not what Meta documents.
      body: { subscribed_fields: SUBSCRIBED_FIELDS.join(',') },
    });
  }

  /**
   * Replies to a comment.
   *
   * THE EDGE DIFFERS BY PLATFORM, and using the wrong one fails in a way that
   * reads like a missing object: Facebook nests a reply under
   * `{comment-id}/comments`, Instagram under `{comment-id}/replies`. Posting
   * Facebook's form to an Instagram comment returns "Unsupported post request.
   * Object with ID ... does not exist, cannot be loaded due to missing
   * permissions, or does not support this operation" — which sends you looking
   * for a deleted comment or a permission problem, when the object is fine and
   * only the edge is wrong.
   */
  async replyToComment(
    commentId: string,
    message: string,
    pageAccessToken: string,
    platform: Platform = Platform.Facebook,
  ): Promise<SendResult> {
    const edge = platform === Platform.Instagram ? 'replies' : 'comments';
    const result = await this.request<{ id: string }>('POST', `${commentId}/${edge}`, {
      accessToken: pageAccessToken,
      body: { message },
    });
    return { platformId: result.id };
  }

  /**
   * Hides or unhides a comment.
   *
   * THE PARAMETER NAME DIFFERS BY PLATFORM: a Page comment takes `is_hidden`, an
   * Instagram comment takes `hide`. Sending is_hidden to Instagram is not an
   * error — Meta accepts the call and ignores the unknown field — so hiding an
   * Instagram comment reported success and did nothing at all, which is the
   * worst possible outcome for a moderation action.
   *
   * Same shape as replyToComment, which differs by platform for the same reason.
   */
  async hideComment(
    commentId: string,
    hidden: boolean,
    pageAccessToken: string,
    platform: Platform = Platform.Facebook,
  ): Promise<void> {
    const body =
      platform === Platform.Instagram ? { hide: String(hidden) } : { is_hidden: String(hidden) };

    await this.request('POST', commentId, { accessToken: pageAccessToken, body });
  }

  async deleteComment(commentId: string, pageAccessToken: string): Promise<void> {
    await this.request('DELETE', commentId, { accessToken: pageAccessToken });
  }

  /**
   * Sends a direct message. Addressed to `{pageId}/messages` explicitly rather
   * than `me/messages`: relying on the token to resolve `me` makes the target
   * implicit, and a mis-scoped token then sends from the wrong Page.
   */
  async sendDirectMessage(
    pageId: string,
    recipientPlatformId: string,
    message: string,
    pageAccessToken: string,
    /**
     * The platform id of the message this answers.
     *
     * Sits BESIDE `message`, not inside it — Meta rejects it nested. Omitted
     * entirely when absent rather than sent as null, because an empty reply_to
     * is an error rather than "no reply".
     */
    replyToPlatformMessageId?: string,
  ): Promise<SendResult> {
    const result = await this.request<{ message_id?: string; id?: string }>(
      'POST',
      `${pageId}/messages`,
      {
        accessToken: pageAccessToken,
        body: {
          recipient: JSON.stringify({ id: recipientPlatformId }),
          message: JSON.stringify({ text: message }),
          messaging_type: 'RESPONSE',
          ...(replyToPlatformMessageId
            ? { reply_to: JSON.stringify({ mid: replyToPlatformMessageId }) }
            : {}),
        },
      },
    );
    return { platformId: result.message_id ?? result.id ?? '' };
  }

  /**
   * appsecret_proof = HMAC-SHA256(appSecret, accessToken), hex.
   *
   * Kept private and never logged or returned: it is derived from the app secret
   * and is as sensitive as the token it accompanies.
   */
  private appSecretProof(accessToken: string): string {
    return createHmac('sha256', this.config.meta.appSecret).update(accessToken).digest('hex');
  }

  /**
   * One page of the Page's OWN posts, optionally with each post's first comments.
   *
   * `published_posts`, NOT `feed`, and the difference is not cosmetic: /feed
   * also contains posts made by other people on the Page, so Meta gates it
   * behind the "Page Public Content Access" feature — an App Review item. With
   * pages_read_engagement alone /feed returns error #10 and the walk dies, while
   * /published_posts returns the Page's own posts and their comments, which is
   * what an inbox is about. Verified against a live Page: /feed 400,
   * /published_posts 200.
   *
   * The trade-off is explicit: comments on visitor posts are not backfilled.
   * Live webhooks still deliver them, because the `feed` WEBHOOK field is a
   * different mechanism from the /feed read edge.
   *
   * `withComments` exists so the posts and comments walks share ONE cursor:
   * asking for comments as a nested edge costs one round trip instead of one per
   * post, which is the difference between a backfill that finishes and one that
   * exhausts the rate limit.
   */
  async listPagePosts(
    pageId: string,
    pageAccessToken: string,
    options: { after?: string; withComments?: boolean } = {},
  ): Promise<GraphEdge<GraphFeedPost>> {
    const fields = [
      'id',
      'message',
      'story',
      'created_time',
      'permalink_url',
      // Without status_type every post is indistinguishable and lands as
      // post_kind 'text' — a photo album included.
      'status_type',
      'full_picture',
      'attachments{type,media}',
      /*
       * Engagement counts, each asked for by name. Without these three,
       * posts.like_count and posts.share_count stayed at their column default of
       * zero for every Facebook post — columns the API sorts on and nothing ever
       * wrote. `comment_summary` is aliased because `comments` is already used
       * above for the actual comment rows and Graph will not return one field
       * twice under one name.
       */
      'reactions.summary(total_count).limit(0)',
      'comment_summary:comments.summary(total_count).limit(0)',
      'shares',
      ...(options.withComments
        ? [
            `comments.limit(${SYNC_COMMENTS_PER_POST}){id,message,created_time,from{id,name},parent{id}}`,
          ]
        : []),
    ].join(',');

    return this.request<GraphEdge<GraphFeedPost>>('GET', `${pageId}/published_posts`, {
      accessToken: pageAccessToken,
      params: {
        fields,
        limit: String(SYNC_PAGE_SIZE),
        ...(options.after ? { after: options.after } : {}),
      },
    });
  }

  /**
   * One page of a Page's message threads, each with its most recent messages.
   *
   * Messages come back newest-first from Graph, which is why the projector keys
   * on the platform message id rather than arrival order.
   */
  async listPageConversations(
    pageId: string,
    pageAccessToken: string,
    after?: string,
    /**
     * ONE participant's thread, by their Page-scoped id.
     *
     * Meta supports filtering the conversations edge to a single person, which
     * turns a repair from a walk of the whole account into one call. Without it
     * the only way to recover a message a webhook never delivered is to re-read
     * every conversation the business has.
     */
    userId?: string,
  ): Promise<GraphEdge<GraphConversation>> {
    const messageFields = `messages.limit(${SYNC_MESSAGES_PER_CONVERSATION}){id,message,created_time,from{id,name},to{data{id,name}},attachments{id,name,mime_type,image_data,video_data,file_url},reply_to,shares}`;

    return this.request<GraphEdge<GraphConversation>>('GET', `${pageId}/conversations`, {
      accessToken: pageAccessToken,
      params: {
        fields: `id,updated_time,participants{id,name,username},${messageFields}`,
        limit: String(SYNC_PAGE_SIZE),
        ...(after ? { after } : {}),
        ...(userId ? { user_id: userId } : {}),
      },
    });
  }

  /**
   * One Instagram customer's profile, by their scoped id.
   *
   * The conversations edge gives an id and a handle; this is the only source of
   * the picture, the real display name, and whether they follow the business.
   * Verified against the live account with the Page token already in use — no
   * additional permission was needed beyond what messaging already requires.
   */
  async getInstagramUserProfile(
    instagramScopedId: string,
    accessToken: string,
  ): Promise<GraphInstagramUserProfile> {
    return this.request<GraphInstagramUserProfile>('GET', instagramScopedId, {
      accessToken,
      params: {
        fields:
          'name,username,profile_pic,follower_count,is_verified_user,' +
          'is_user_follow_business,is_business_follow_user',
      },
    });
  }

  /**
   * One page of an Instagram account's media, with each item's first comments.
   *
   * This is the path the previous product actually used, and it needs no
   * permission beyond instagram_basic + instagram_manage_comments — unlike
   * Facebook Page comments, which require pages_read_user_content. So Instagram
   * comments are readable today while Facebook's are not.
   *
   * `from{id,username}` is requested EXPLICITLY. The edge returns only
   * `username` by default, and a handle is not an identity: it can be changed
   * and reused, so a comment without `from.id` cannot be filed against a
   * customer and is skipped downstream.
   */
  async listInstagramMedia(
    instagramUserId: string,
    accessToken: string,
    after?: string,
  ): Promise<GraphEdge<GraphInstagramMedia>> {
    const commentFields = `comments.limit(${SYNC_COMMENTS_PER_POST}){id,text,timestamp,username,like_count,hidden,from{id,username},parent_id}`;

    return this.request<GraphEdge<GraphInstagramMedia>>('GET', `${instagramUserId}/media`, {
      accessToken,
      params: {
        // like_count is requested explicitly for the same reason the Facebook
        // reaction summary is: the column exists, is sorted on, and was never
        // written because nothing asked the platform for it.
        fields: `id,caption,media_type,permalink,timestamp,comments_count,like_count,media_url,thumbnail_url,${commentFields}`,
        limit: String(SYNC_PAGE_SIZE),
        ...(after ? { after } : {}),
      },
    });
  }

  /**
   * One page of Instagram message threads.
   *
   * Addressed to the linked PAGE with `platform=instagram`, not to the Instagram
   * account: Instagram messaging is served through the Page's conversations
   * edge. Verified against a live account — the Instagram id has no
   * conversations edge of its own here.
   */
  async listInstagramConversations(
    pageId: string,
    accessToken: string,
    after?: string,
    /** One participant's thread, by IGSID — see listPageConversations. */
    userId?: string,
  ): Promise<GraphEdge<GraphConversation>> {
    const messageFields = `messages.limit(${SYNC_MESSAGES_PER_CONVERSATION}){id,message,created_time,from{id,name,username},to{data{id,name,username}},attachments{id,name,mime_type,image_data,video_data,file_url},reply_to,shares}`;

    return this.request<GraphEdge<GraphConversation>>('GET', `${pageId}/conversations`, {
      accessToken,
      params: {
        platform: 'instagram',
        fields: `id,updated_time,participants{id,name,username},${messageFields}`,
        limit: String(SYNC_PAGE_SIZE),
        ...(after ? { after } : {}),
        ...(userId ? { user_id: userId } : {}),
      },
    });
  }

  /**
   * Posts by OTHER people that tagged this Instagram account — the `tags` edge.
   *
   * The only way to see the ones that happened before the app was connected.
   * Meta's `mentions` webhook covers comment mentions from now on and has no
   * history, so without this a business's mention feed starts empty and stays
   * that way for anything older than the connection.
   */
  async listInstagramTags(
    instagramUserId: string,
    accessToken: string,
    after?: string,
  ): Promise<GraphEdge<GraphInstagramTag>> {
    return this.request<GraphEdge<GraphInstagramTag>>('GET', `${instagramUserId}/tags`, {
      accessToken,
      params: {
        fields:
          'id,caption,media_type,media_url,permalink,timestamp,username,like_count,comments_count',
        limit: String(SYNC_PAGE_SIZE),
        ...(after ? { after } : {}),
      },
    });
  }

  /**
   * Resolves a `mentions` webhook into something projectable.
   *
   * THE WEBHOOK GIVES TWO IDS AND NOTHING ELSE — no author, no text — so a live
   * mention cannot be stored without this call. The ids are read back off OUR
   * OWN user node, which is what makes it work: the mention itself is the grant,
   * so this returns the caption, permalink and owner of a post belonging to an
   * account we do not manage and could not otherwise read
   * (docs/platform-limitations.md §1.2, §3.1).
   *
   * WHICH EDGE IS DECIDED BY THE PAYLOAD, not by trying both. A mention in a
   * comment carries `comment_id`; a mention in a caption does not. Asking
   * mentioned_media about a comment mention fails with
   * `(#10) User is not mentioned in the caption.`
   *
   * Returns null when the mention resolves to nothing usable — the author is
   * the one field the projector cannot do without.
   */
  async resolveInstagramMention(
    instagramUserId: string,
    target: { readonly commentId?: string | null; readonly mediaId?: string | null },
    accessToken: string,
  ): Promise<ResolvedMention | null> {
    /*
     * WHY THESE FIELDS AND NOT MORE. Every one was probed individually against
     * live traffic; the omissions are deliberate, not oversights:
     *
     *   share_count / saved / video_view_count — do not exist on the media node
     *   shortcode / is_shared_to_feed          — not exposed on others' media
     *
     * The COMMENT branch builds its own field list in fetchMentionedComment,
     * which is where the reply thread is asked for and where the rules about it
     * belong. This list serves the caption branch, which has no comment at all.
     */
    const mediaFields =
      'id,caption,media_type,media_product_type,media_url,thumbnail_url,' +
      'permalink,username,timestamp,like_count,comments_count';

    if (target.commentId) {
      /*
       * A MENTION CAN ITSELF BE A REPLY, and then it has no replies of its own.
       *
       * Somebody can tag us in a reply to a comment rather than in a top-level
       * comment, and asking a reply for `replies` fails the WHOLE query with
       * `(#100) Field is only available for top-level comments` — so a fat
       * query that always asked for them lost the entire mention, author and
       * all, over a field that could never have applied. Observed live: event
       * 1523, skipped as "carries no author" when Meta was perfectly willing to
       * describe it.
       *
       * So the thread is asked for once and dropped on exactly that error. One
       * call for a top-level mention, two only for a nested one — rather than
       * paying for a `parent_id` probe on every mention to learn which it is.
       */
      const comment =
        (await this.fetchMentionedComment(instagramUserId, target.commentId, accessToken, true)) ??
        (await this.fetchMentionedComment(instagramUserId, target.commentId, accessToken, false));

      if (!comment?.username) return null;
      return {
        authorUsername: comment.username,
        text: comment.text ?? null,
        likeCount: numberOrNull(comment.like_count),
        timestamp: comment.timestamp ?? null,
        mediaId: comment.media?.id ?? target.mediaId ?? null,
        permalink: comment.media?.permalink ?? null,
        mediaOwnerUsername: comment.media?.username ?? null,
        media: toResolvedMedia(comment.media, target.mediaId ?? null),
        replies: toResolvedReplies(comment.replies?.data),
        parentCommentId: comment.parent_id ?? null,
        postComments: await this.listMentionedPostComments(
          instagramUserId,
          target.commentId,
          accessToken,
        ),
        parent: comment.parent_id
          ? await this.fetchMentionThreadParent(instagramUserId, comment.parent_id, accessToken)
          : null,
      };
    }

    if (!target.mediaId) return null;

    const result = await this.request<{ mentioned_media?: GraphMentionedMedia }>(
      'GET',
      instagramUserId,
      {
        accessToken,
        params: { fields: `mentioned_media.media_id(${target.mediaId}){${mediaFields}}` },
      },
    );

    const media = result.mentioned_media;
    /*
     * For a CAPTION mention the post's author and the person who named us are
     * the same account, so one username answers both questions.
     */
    if (!media?.username) return null;
    return {
      authorUsername: media.username,
      text: media.caption ?? null,
      // A caption mention has no comment, so nothing can have liked it.
      likeCount: null,
      timestamp: media.timestamp ?? null,
      mediaId: media.id ?? target.mediaId,
      permalink: media.permalink ?? null,
      mediaOwnerUsername: media.username,
      media: toResolvedMedia(media, target.mediaId),
      // A caption mention has no comment, so there is neither a reply thread
      // nor a parent — it IS the top of everything.
      replies: [],
      parentCommentId: null,
      parent: null,
      // A caption mention has no comment id, which is the only key into the
      // post's comment section.
      postComments: [],
    };
  }

  /**
   * One attempt at reading a mention, with or without its reply thread.
   *
   * Returns null ONLY for the nested-comment case, so the caller can retry
   * without the thread. Every other Graph failure is rethrown: a token problem
   * or a rate limit must not be silently downgraded into "this mention has no
   * author", which would skip the event and never look at it again.
   */
  private async fetchMentionedComment(
    instagramUserId: string,
    commentId: string,
    accessToken: string,
    withReplies: boolean,
  ): Promise<GraphMentionedComment | null> {
    const mediaFields =
      'id,caption,media_type,media_product_type,media_url,thumbnail_url,' +
      'permalink,username,timestamp,like_count,comments_count';
    /*
     * `timestamp` in the replies list looks superstitious and is not:
     * `replies{id,text}` fails with "Please reduce the amount of data you're
     * asking for" while `replies{id,text,timestamp}` succeeds
     * (docs/platform-limitations.md §1.4). Removing it breaks the call.
     */
    const replies = withReplies ? 'replies{id,text,timestamp,like_count},' : '';

    try {
      const result = await this.request<{ mentioned_comment?: GraphMentionedComment }>(
        'GET',
        instagramUserId,
        {
          accessToken,
          params: {
            fields: `mentioned_comment.comment_id(${commentId}){id,text,timestamp,username,like_count,parent_id,${replies}media{${mediaFields}}}`,
          },
        },
      );
      return result.mentioned_comment ?? null;
    } catch (error) {
      const isNestedComment =
        withReplies &&
        error instanceof GraphApiError &&
        error.code === 100 &&
        error.message.includes('only available for top-level comments');

      if (isNestedComment) return null;
      throw error;
    }
  }

  /**
   * The comment our mention was replying to, and the rest of that thread.
   *
   * A tag inside a reply is close to meaningless on its own — "tell this guy"
   * needs the comment above it to mean anything — so the parent is fetched to
   * give the agent the conversation rather than a fragment of it.
   *
   * ONLY WORKS WHEN THE PARENT ALSO MENTIONED US. Meta refuses any other
   * comment with `(#10) User is not mentioned in the comment`, which is a
   * boundary rather than a fault: that is treated as "no context available" and
   * the mention is still projected. Every other failure is swallowed too — the
   * parent is enrichment, and losing it must never cost us the mention itself.
   */
  private async fetchMentionThreadParent(
    instagramUserId: string,
    parentCommentId: string,
    accessToken: string,
  ): Promise<ResolvedMentionParent | null> {
    try {
      const parent = await this.fetchMentionedComment(
        instagramUserId,
        parentCommentId,
        accessToken,
        // A parent is by definition top-level, so its thread is always askable.
        true,
      );
      if (!parent) return null;
      return {
        commentId: parent.id ?? parentCommentId,
        text: parent.text ?? null,
        authorUsername: parent.username ?? null,
        timestamp: parent.timestamp ?? null,
        likeCount: numberOrNull(parent.like_count),
        replies: toResolvedReplies(parent.replies?.data),
      };
    } catch {
      return null;
    }
  }

  /**
   * The tagged post's comment section, read through the mention that grants it.
   *
   * A SEPARATE CALL ON PURPOSE. Nesting this inside the mention query risks the
   * whole thing: Graph answers a too-large field expansion with
   * `500 Please reduce the amount of data you're asking for`, and losing the
   * mention to fetch its surroundings would be a bad trade. Here a failure
   * costs only the surroundings.
   *
   * `timestamp` is not optional decoration — `comments{id,text}` alone fails
   * with that same 500 while `{id,text,timestamp}` succeeds
   * (docs/platform-limitations.md §1.4).
   */
  async listMentionedPostComments(
    instagramUserId: string,
    commentId: string,
    accessToken: string,
  ): Promise<ResolvedMentionReply[]> {
    try {
      const result = await this.request<{
        mentioned_comment?: { media?: { comments?: { data?: GraphMentionedCommentReply[] } } };
      }>('GET', instagramUserId, {
        accessToken,
        params: {
          fields: `mentioned_comment.comment_id(${commentId}){media{comments.limit(${MENTION_POST_COMMENTS_KEPT}){id,text,timestamp,like_count}}}`,
        },
      });
      return toResolvedReplies(result.mentioned_comment?.media?.comments?.data);
    } catch {
      /*
       * Deliberately swallowed. This is context, not the mention: a refusal
       * here must not fail a projection or send it back for another attempt
       * against Meta.
       */
      return [];
    }
  }

  /**
   * Answers a comment that @mentioned us.
   *
   * NOT `POST /{comment-id}/replies`, which only works on media we own — a
   * mention is on somebody else's post and that edge fails there. Meta's
   * mentions edge exists for exactly this and posts the reply as a sub-thread
   * comment beneath the mention.
   *
   * `comment_id` is what distinguishes the two shapes: with it, this replies to
   * the comment that named us; without it, it comments on a post that named us
   * in its caption.
   */
  async replyToMention(
    instagramUserId: string,
    target: { readonly mediaId: string; readonly commentId?: string | null },
    message: string,
    accessToken: string,
  ): Promise<SendResult> {
    const result = await this.request<{ id: string }>('POST', `${instagramUserId}/mentions`, {
      accessToken,
      body: {
        media_id: target.mediaId,
        message,
        ...(target.commentId ? { comment_id: target.commentId } : {}),
      },
    });
    return { platformId: result.id };
  }

  /**
   * Which fields this app is actually subscribed to on a Page.
   *
   * The READ side of subscribePageToApp, and it exists because the write side
   * succeeding is not evidence: a subscription can be removed from the Facebook
   * side at any time, and the only symptom is webhooks quietly stopping. This
   * turns "nothing has arrived for a week" into a question with an answer.
   */
  async listSubscribedFields(pageId: string, pageAccessToken: string): Promise<string[]> {
    const result = await this.request<{
      data?: { subscribed_fields?: string[] }[];
    }>('GET', `${pageId}/subscribed_apps`, { accessToken: pageAccessToken });

    return result.data?.[0]?.subscribed_fields ?? [];
  }

  /**
   * A channel's public profile.
   *
   * One method for both platforms because the shapes overlap enough to be worth
   * it and differ only in the field names: a Page has `name` and
   * `followers_count`, an Instagram account `username` and `followers_count`.
   * Requesting a field the platform does not have is an error, not an omission,
   * which is why the list is chosen per platform.
   */
  async getChannelProfile(
    platformChannelId: string,
    accessToken: string,
    platform: Platform,
  ): Promise<{
    name?: string;
    username?: string;
    followers_count?: number;
    fan_count?: number;
    profile_picture_url?: string;
  }> {
    const fields =
      platform === Platform.Instagram
        ? 'username,followers_count,profile_picture_url'
        : 'name,username,followers_count,fan_count';

    return this.request('GET', platformChannelId, { accessToken, params: { fields } });
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: {
      accessToken?: string;
      params?: Record<string, string>;
      body?: Record<string, string>;
      skipProof?: boolean;
    } = {},
  ): Promise<T> {
    const url = new URL(`${GRAPH_HOST}/${this.version}/${path}`);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      url.searchParams.set(key, value);
    }

    const form = new URLSearchParams(options.body ?? {});
    if (options.accessToken) {
      // Token and proof travel in the body for writes, the query for reads.
      const target = method === 'GET' || method === 'DELETE' ? url.searchParams : form;
      target.set('access_token', options.accessToken);
      if (!options.skipProof) {
        target.set('appsecret_proof', this.appSecretProof(options.accessToken));
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        // Every external call is bounded. An unbounded platform call ties up a
        // worker slot indefinitely when Meta stalls.
        signal: AbortSignal.timeout(PLATFORM_REQUEST_TIMEOUT_MS),
        ...(method === 'POST'
          ? {
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: form.toString(),
            }
          : {}),
      });
    } catch (cause) {
      // Timeout, DNS, reset: the outcome is UNKNOWN, which matters for sends.
      throw GraphApiError.fromTransport(cause, `graph ${method} ${path} did not complete`);
    }

    // Inside the guard: the abort signal also cancels body streaming, and a
    // reset can arrive after the headers, so this can reject on its own. Letting
    // that escape as a non-GraphApiError would make the relay treat a possibly
    // delivered send as a plain failure and retry it.
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw GraphApiError.fromTransport(cause, `graph ${method} ${path} body was interrupted`);
    }

    const parsed: unknown = text ? safeJsonParse(text) : {};

    if (!response.ok) {
      const body = (parsed ?? {}) as { error?: Record<string, unknown> };
      const error = body.error ?? {};
      throw new GraphApiError(
        response.status,
        typeof error.code === 'number' ? error.code : null,
        typeof error.error_subcode === 'number' ? error.error_subcode : null,
        typeof error.type === 'string' ? error.type : null,
        typeof error.fbtrace_id === 'string' ? error.fbtrace_id : null,
        // Meta's message is safe to keep for diagnosis; it names no token.
        typeof error.message === 'string' ? error.message : `graph ${method} ${path} failed`,
        // What Meta itself says about waiting, when it says anything.
        readRetryAfterMinutes(response.headers),
      );
    }

    return parsed as T;
  }
}

/**
 * Meta's own estimate of when a throttled app may call again, in minutes.
 *
 * Both headers carry JSON. `X-App-Usage` is a flat object; the business one is
 * keyed by business id, each value an ARRAY of per-endpoint objects — so the
 * largest estimate across all of them is the one to wait for, because any
 * smaller wait would still be throttled.
 *
 * Entirely best-effort: these headers appear only under quota pressure, their
 * shape is undocumented in places, and a malformed one must not turn a rate
 * limit into a parse error. Null means "Meta did not say", and the caller falls
 * back to its own park window.
 */
function readRetryAfterMinutes(headers: Headers): number | null {
  let longest: number | null = null;

  const consider = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    const estimate = (value as { estimated_time_to_regain_access?: unknown })
      .estimated_time_to_regain_access;
    if (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate <= 0) return;
    longest = longest === null ? estimate : Math.max(longest, estimate);
  };

  for (const name of ['x-app-usage', 'x-business-use-case-usage', 'x-ad-account-usage']) {
    const raw = headers.get(name);
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    consider(parsed);
    // The business-scoped header nests one array of endpoint objects per id.
    if (typeof parsed === 'object' && parsed !== null) {
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (Array.isArray(value)) value.forEach(consider);
        else consider(value);
      }
    }
  }

  return longest;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: 'graph returned a non-JSON body' } };
  }
}

/**
 * A count that was refused reads as ABSENT, never as zero.
 *
 * Meta returns a 200 with the field simply missing when it will not give a
 * number, and defaulting that to 0 would put "0 likes" on a post with a hundred
 * thousand of them — a confident lie is worse than an honest blank.
 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function toResolvedMedia(
  media: GraphMentionedMedia | undefined,
  fallbackId: string | null,
): ResolvedMentionMedia | null {
  if (!media) return null;
  return {
    id: media.id ?? fallbackId,
    caption: media.caption ?? null,
    permalink: media.permalink ?? null,
    ownerUsername: media.username ?? null,
    mediaType: media.media_type ?? null,
    mediaUrl: media.media_url ?? null,
    /*
     * A REEL RETURNS NO media_url AT ALL — only a thumbnail. Asking for the one
     * and not the other left every reel mention with no preview whatsoever,
     * while the field that would have shown it sat one word away.
     */
    thumbnailUrl: media.thumbnail_url ?? null,
    productType: media.media_product_type ?? null,
    timestamp: media.timestamp ?? null,
    likeCount: numberOrNull(media.like_count),
    commentsCount: numberOrNull(media.comments_count),
  };
}

function toResolvedReplies(
  replies: readonly GraphMentionedCommentReply[] | undefined,
): ResolvedMentionReply[] {
  if (!replies?.length) return [];
  return replies
    .filter((reply): reply is GraphMentionedCommentReply & { id: string } => Boolean(reply.id))
    .map((reply) => ({
      platformId: reply.id,
      // Absent for a media-only reply, and that is not an error.
      text: reply.text ?? null,
      timestamp: reply.timestamp ?? null,
      likeCount: numberOrNull(reply.like_count),
    }));
}
