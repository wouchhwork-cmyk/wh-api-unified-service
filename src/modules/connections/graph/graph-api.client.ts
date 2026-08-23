import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '@/config';
import {
  PLATFORM_REQUEST_TIMEOUT_MS,
  SYNC_COMMENTS_PER_POST,
  SYNC_MESSAGES_PER_CONVERSATION,
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
  GraphMeResponse,
  GraphTokenResponse,
  SendResult,
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
  ): Promise<GraphEdge<GraphConversation>> {
    const messageFields = `messages.limit(${SYNC_MESSAGES_PER_CONVERSATION}){id,message,created_time,from{id,name},to{data{id,name}}}`;

    return this.request<GraphEdge<GraphConversation>>('GET', `${pageId}/conversations`, {
      accessToken: pageAccessToken,
      params: {
        fields: `id,updated_time,participants{id,name,username},${messageFields}`,
        limit: String(SYNC_PAGE_SIZE),
        ...(after ? { after } : {}),
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
  ): Promise<GraphEdge<GraphConversation>> {
    const messageFields = `messages.limit(${SYNC_MESSAGES_PER_CONVERSATION}){id,message,created_time,from{id,name,username},to{data{id,name,username}}}`;

    return this.request<GraphEdge<GraphConversation>>('GET', `${pageId}/conversations`, {
      accessToken,
      params: {
        platform: 'instagram',
        fields: `id,updated_time,participants{id,name,username},${messageFields}`,
        limit: String(SYNC_PAGE_SIZE),
        ...(after ? { after } : {}),
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
