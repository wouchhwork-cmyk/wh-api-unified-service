/**
 * Meta meters our Graph calls with TWO separate systems, and which one applies
 * is decided by the token, not by the endpoint.
 *
 * Measured on live responses 21 Sep 2026 with our own app and confirmed against
 * Meta's rate-limiting documentation. The two never appeared on the same
 * response: a call carries one meter or the other.
 */
export enum MetaUsageMeter {
  /**
   * `X-App-Usage` — ONE pool for the entire developer app, shared by every
   * business on the platform.
   *
   * Returned for calls made with an app access token or a USER access token.
   * That is the OAuth and discovery path — `oauth/access_token`, `debug_token`,
   * `me`, `me/accounts` — so in this product the app pool is drained by
   * businesses CONNECTING, not by the inbox.
   *
   * The allowance is `200 x daily active users` per rolling hour, and "users"
   * means people actively using the app that day, not accounts we have stored.
   * A B2B product has very few of those, so this pool is small and does not
   * grow just because more businesses have connected.
   */
  App = 'app',

  /**
   * `X-Business-Use-Case-Usage` — one pool per business PER PRODUCT.
   *
   * Returned for calls made with a Page or Instagram token, which is the entire
   * hot path: conversations, messages, comments, media, posts.
   *
   * Meta's documentation states that where both meters could apply, this one is
   * applied INSTEAD OF the app meter — and our measurements agree: ninety
   * page-token and Instagram-token calls moved the app counter not at all.
   * So the inbox cannot exhaust the app pool, and one noisy business cannot
   * starve another.
   */
  BusinessUseCase = 'business_use_case',

  /**
   * NEITHER, because the call came back without a usage header at all.
   *
   * A timeout, a reset, or one of the responses Meta documents as carrying no
   * header. The call was made and is worth counting, but nothing was learned
   * about any pool — and attributing it to one is actively harmful: a
   * Page-token call that timed out touched no app allowance, so filing it under
   * `App` writes a NULL percentage that then reads as the app pool's current
   * state and blanks a gauge that was working.
   *
   * It exists as a third value rather than being folded into `App` because the
   * console keys the app gauge off the meter. Sharing the value meant the
   * headerless row WAS the app pool as far as the grouping was concerned — and
   * it sorted last, so it won every time.
   */
  Unknown = 'unknown',
}

/**
 * The `type` inside a business-use-case entry: which pool of that business was
 * drawn on.
 *
 * NOT exhaustive and deliberately not enforced at the database. Meta documents
 * seven values today and adds more; an unrecognised one is stored as it arrived
 * rather than dropped, because a pool we cannot name is still a pool that can
 * throttle us. See `isKnownUsageProduct`.
 */
export enum MetaUsageProduct {
  /** Media, comments, mentions, insights. `4800 x impressions` per 24 hours. */
  Instagram = 'instagram',
  /** Conversations and messages. `200 x engaged users` per 24 hours. */
  Messenger = 'messenger',
  /** Page reads. `4800 x engaged users` per 24 hours. */
  Pages = 'pages',
  AdsInsights = 'ads_insights',
  AdsManagement = 'ads_management',
  CustomAudience = 'custom_audience',
  LeadGen = 'leadgen',
}

const KNOWN_PRODUCTS = new Set<string>(Object.values(MetaUsageProduct));

/** Whether Meta's `type` is one we have a documented window and formula for. */
export function isKnownUsageProduct(value: string): value is MetaUsageProduct {
  return KNOWN_PRODUCTS.has(value);
}
