/**
 * Reward programs — the vocabulary.
 *
 * Design: docs/reward-programs-design.md. Enum values are lower snake_case
 * strings in VARCHAR, validated in the service layer and NOT by CHECK
 * constraints, so adding a kind is a code change rather than a migration
 * (schema.md §2).
 */

/**
 * What the customer DID. Audited against SUBSCRIBED_FIELDS and the projectors
 * that consume each field — not against the product description, which is how
 * the first draft of this list came to be half the real size.
 *
 * Deliberately absent, each for a reason: `message_echoes` (the sender is us),
 * `message_reads` (a read receipt is farmable by reopening a thread) and
 * `message_edits` (editing is not new engagement, and allowing it to earn
 * creates a re-trigger attack — post once, edit fifty times).
 */
export enum RewardTriggerKind {
  DirectMessageInbound = 'direct_message_inbound',
  /** They replied to OUR story. */
  StoryReply = 'story_reply',
  /** They mentioned us in THEIR story. */
  StoryMention = 'story_mention',
  MessageReaction = 'message_reaction',
  /** An ice breaker or a template button. Filterable on the button's payload. */
  PostbackTapped = 'postback_tapped',
  /** A consent event, not a message. */
  OptInGranted = 'opt_in_granted',
  /**
   * How they arrived — an ad, a ref link, a QR code. Carries `ref`, `source`,
   * `type` and `ad_id`, all of which we already store on platformFacts. This is
   * "scan this in store and get 50 points" with no integration work left.
   */
  ReferralEntry = 'referral_entry',
  CommentOnOwnPost = 'comment_on_own_post',
  /** A comment on somebody else's post that tags us. */
  CommentOnMentionedPost = 'comment_on_mentioned_post',
  PostTaggingUs = 'post_tagging_us',
  /** Inert until mention monitoring is resolved — todo.md E8. */
  PostCaptionMention = 'post_caption_mention',
  /**
   * BLOCKED until todo.md B4. `feed` delivers likes, but `item: 'like'` is
   * modelled nowhere: the change routes to the post projector, falls through
   * `toPostKind` to PostKind.Text, and the actor is discarded. The trigger
   * exists here so a rule referencing it is representable; it cannot fire.
   */
  PostLike = 'post_like',
  /** BLOCKED — same as PostLike. */
  PostShare = 'post_share',
  /**
   * INTERNAL. Not a social event: the balance crossed a threshold. This is what
   * makes a conversion ("30 points becomes ₹50") an ordinary rule rather than a
   * parallel mechanism with its own table, its own caps and its own audit path.
   */
  PointsBalanceReached = 'points_balance_reached',
}

/** Whether an event QUALIFIES. Flat AND list per rule — no boolean tree. */
export enum RewardConditionKind {
  /** Day-of-week plus local wall-clock slots. Slots OR; conditions AND. */
  TimeWindow = 'time_window',
  /** "Must have engaged with us before today" — the cheapest abuse control. */
  CustomerTenure = 'customer_tenure',
  /** A keyword in the comment body or the post caption. */
  ContentMatch = 'content_match',
}

/**
 * What the customer GETS. One entry per handler.
 *
 * Named "benefit" rather than "effect": the repo's vocabulary is concrete
 * throughout, `grant` already means an RBAC grant here, and every member below
 * is something the customer receives. Forwarding is deliberately NOT a member —
 * it is driven by the program's forward_provider_code and modelled as ledger
 * entries plus an outbound_events row, not as something a rule declares.
 */
export enum RewardBenefitKind {
  GrantPoints = 'grant_points',
  GrantCurrency = 'grant_currency',
  IssueEntitlement = 'issue_entitlement',
  ConvertValue = 'convert_value',
}

/**
 * The benefit kinds whose payload carries a currency.
 *
 * ONE LIST. It was declared in the evaluator and about to be declared again
 * beside the rule-creation guard — two copies of the same domain fact, which
 * disagree the day somebody adds a third money benefit and updates one of
 * them. It lives with the enum it is about.
 */
export const CURRENCY_BEARING_BENEFITS: ReadonlySet<RewardBenefitKind> = new Set([
  RewardBenefitKind.GrantCurrency,
  RewardBenefitKind.ConvertValue,
]);

/**
 * Whether a benefit can be undone.
 *
 * Two thirds of a mature loyalty engine is irreversible — Talon.One ships 42
 * effect types, 8 rollbacks covering 12 of them. So reversibility is declared,
 * and a Pivot must say WHY in code rather than in a wiki.
 */
export enum Reversibility {
  Compensable = 'compensable',
  Pivot = 'pivot',
}

/** Whether the factor may scale this benefit. A coffee cannot be 0.6 of a coffee. */
export enum RewardAwardMode {
  Fixed = 'fixed',
  UpTo = 'up_to',
}

export enum RewardProgramStatus {
  /** Never switched on. */
  Draft = 'draft',
  /** Switched on. Says NOTHING about being inside the dates or the windows. */
  Active = 'active',
  Paused = 'paused',
  Archived = 'archived',
}

/**
 * How often one customer may earn from one rule.
 *
 * `period_key` is derived from this in the PROGRAM's timezone, so a Mumbai
 * café's "once a day" does not reset at 05:30 local.
 */
export enum RewardCapScope {
  Lifetime = 'lifetime',
  Day = 'day',
  Week = 'week',
  Month = 'month',
  Year = 'year',
  None = 'none',
}

/**
 * An award's lifecycle.
 *
 * The three `skipped_*` values are terminal and are RECORDED rather than
 * discarded: "why didn't I get my points?" is a question the enterprise will be
 * asked, and one row with a period_key answers it.
 */
export enum RewardAwardStatus {
  Held = 'held',
  Granted = 'granted',
  Reversed = 'reversed',
  SkippedCap = 'skipped_cap',
  /** reason_code names WHICH condition failed. */
  SkippedCondition = 'skipped_condition',
  /** A zero factor does not consume the cap slot — they did not earn. */
  SkippedZeroFactor = 'skipped_zero_factor',
  Expired = 'expired',
}

/** Whether deleted or hidden content takes the award back. */
export enum RewardReversalPolicy {
  None = 'none',
  OnContentDeleted = 'on_content_deleted',
}

/** Per applied benefit row. */
export enum RewardBenefitStatus {
  Applied = 'applied',
  Compensated = 'compensated',
  Failed = 'failed',
  Dead = 'dead',
}

/**
 * Points and money are different scales in one column, and this says which.
 *
 * `points` means WHOLE points — 340 is 340, never 3.40. `currency` means minor
 * units, whose scale comes from the ISO 4217 exponent and never from a
 * hardcoded 100 (JPY and KRW are 0; KWD and BHD are 3).
 */
export enum RewardWalletKind {
  Points = 'points',
  Currency = 'currency',
}

/**
 * Whose balance this is.
 *
 * The two system kinds have no customer. `system_transit` holds value that has
 * been forwarded and not yet confirmed — it must drain to approximately zero,
 * and a balance that does not is a stuck forward somebody can SEE rather than a
 * report nobody runs.
 */
export enum RewardAccountKind {
  Customer = 'customer',
  SystemTransit = 'system_transit',
  SystemExternal = 'system_external',
}

/**
 * Ledger entry kinds. Append-only: corrections are reversing entries, never an
 * UPDATE and never a DELETE.
 */
export enum RewardEntryKind {
  Earn = 'earn',
  Burn = 'burn',
  /** Paired by group_ref — a conversion is burn-then-earn, never a lot move. */
  ConvertOut = 'convert_out',
  ConvertIn = 'convert_in',
  /** Forwarding: the value LEAVES, so the customer's balance must drop. */
  ForwardOut = 'forward_out',
  TransitIn = 'transit_in',
  TransitOut = 'transit_out',
  ExternalOut = 'external_out',
  /** A forward that died permanently. The value comes back. */
  ForwardBack = 'forward_back',
  Reversal = 'reversal',
  /** Human, needs a permission, and carries actor_kind + actor_id. */
  Adjust = 'adjust',
  /** Customer merge: wallets merge by transfer, never by repointing rows. */
  TransferIn = 'transfer_in',
  TransferOut = 'transfer_out',
}

/** An issued right, not a balance. A free coffee is not a number that goes up. */
export enum RewardEntitlementStatus {
  Issued = 'issued',
  Reserved = 'reserved',
  Redeemed = 'redeemed',
  Expired = 'expired',
  Revoked = 'revoked',
}

/** ISO 8601 day-of-week, matching Postgres EXTRACT(ISODOW). */
export const ISO_MONDAY = 1;
export const ISO_SUNDAY = 7;

/**
 * The factor is carried as basis points so the arithmetic stays integer.
 *
 * A provider returns [0,1]; it is clamped to [0, 10000] AT THE BOUNDARY, not
 * inside the provider, because the provider is the thing most likely to change
 * and a return of 1.5 must not pay 30 against a cap of 20.
 */
export const FACTOR_BASIS_POINTS_MAX = 10_000;

/** The V1 provider: returns 1.0, so an `up_to` benefit pays its full cap. */
export const CONSTANT_ONE_FACTOR_PROVIDER = 'constant_one';

/** The V1 forwarding provider: records intent, moves NO value. */
export const NOOP_FORWARD_PROVIDER = 'noop';
