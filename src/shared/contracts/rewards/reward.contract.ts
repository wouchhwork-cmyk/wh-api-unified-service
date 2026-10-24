import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/shared/constants';
import { CurrencyCodeSchema } from '@/shared/contracts/enterprises/settings.contract';
import {
  ISO_MONDAY,
  ISO_SUNDAY,
  RewardAwardMode,
  RewardBenefitKind,
  RewardCapScope,
  RewardConditionKind,
  RewardProgramStatus,
  RewardTriggerKind,
  RewardWalletKind,
} from '@/shared/enums';

/**
 * Reward programs — the wire contract.
 *
 * The two discriminated unions below are the heart of it. They are used in
 * THREE places, and each catches something the others cannot:
 *
 *   - on WRITE, at the repository boundary, so a bad payload never lands;
 *   - on READ, when a stored rule is loaded, so a payload written before a
 *     schema change fails loudly instead of arriving with a missing property
 *     that TypeScript insists is present;
 *   - in CI, over every stored row, because a constraint is a GATE and never an
 *     audit — Postgres will report a CHECK as valid while rows violate it.
 *
 * Vendure stores the same shape and does only the middle one, coercing on read
 * with no write-time check. Rename an argument there and it is silently
 * dropped while the type asserts it is present. That is the exact divergence —
 * `productIds` to `productId` across 58 rows — found in the production coupon
 * engine this design was checked against.
 *
 * `strictObject` everywhere, deliberately: an unknown key is a typo or a
 * stale client, and silently discarding it is how the two halves drift apart.
 */

/** Money is minor units and a currency, always travelling together. */
const MinorUnitsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/*
 * THE SHARED ONE, checked against the ISO 4217 list rather than a shape.
 *
 * This file used to declare its own: `/^[A-Z]{3}$/`, which describes what a
 * currency code looks like instead of testing whether it is one. `XYZ`, `ABC`
 * and `ZZZ` were accepted and stored, and a wallet could be opened in a
 * currency that does not exist.
 *
 * A benefit may still name a currency of its own — a promotion can pay in
 * something other than the business's usual — so the field stays here. What
 * changed is that it now has to be real.
 */

/* ========================================================================
 * Benefits — what the customer gets
 * ===================================================================== */

export const GrantPointsConfigSchema = z.strictObject({
  /** WHOLE points. Never a minor unit, never a float. */
  points: z.number().int().positive(),
});

export const GrantCurrencyConfigSchema = z.strictObject({
  minorUnits: MinorUnitsSchema.refine((v) => v > 0, 'must be positive'),
  /*
   * OPTIONAL, and unstated means the business's own currency.
   *
   * Required here, the business setting could never be the answer to
   * anything — every benefit would repeat it, and a business changing
   * currency would have to edit every rule it owns. Stating one is for the
   * case it exists for: a promotion paying in something other than the usual.
   */
  currencyCode: CurrencyCodeSchema.optional(),
});

export const IssueEntitlementConfigSchema = z.strictObject({
  itemRef: z.string().trim().min(1).max(64),
  /** Null = never expires. */
  validForDays: z.number().int().positive().max(3650).nullable().default(null),
});

export const ConvertValueConfigSchema = z.strictObject({
  burnPoints: z.number().int().positive(),
  grantMinor: MinorUnitsSchema.refine((v) => v > 0, 'must be positive'),
  /* Optional for the same reason as `grant_currency` above. */
  currencyCode: CurrencyCodeSchema.optional(),
});

/**
 * The benefit union.
 *
 * Adding a kind is: one member here, one handler file, one line in the registry
 * — and the last two are demanded by the compiler by name. Zero migrations,
 * because the payload is JSONB and the discriminator is an unconstrained
 * VARCHAR.
 */
export const RewardBenefitConfigSchema = z.discriminatedUnion('benefitKind', [
  z.strictObject({
    benefitKind: z.literal(RewardBenefitKind.GrantPoints),
    config: GrantPointsConfigSchema,
  }),
  z.strictObject({
    benefitKind: z.literal(RewardBenefitKind.GrantCurrency),
    config: GrantCurrencyConfigSchema,
  }),
  z.strictObject({
    benefitKind: z.literal(RewardBenefitKind.IssueEntitlement),
    config: IssueEntitlementConfigSchema,
  }),
  z.strictObject({
    benefitKind: z.literal(RewardBenefitKind.ConvertValue),
    config: ConvertValueConfigSchema,
  }),
]);

export type RewardBenefitConfig = z.infer<typeof RewardBenefitConfigSchema>;

/* ========================================================================
 * Conditions — whether the event qualifies
 * ===================================================================== */

/** "18:00". Local wall clock, resolved in the PROGRAM's timezone. */
const WallClockSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm, 24-hour, local wall clock');

/**
 * One slot. `start > end` means it wraps past midnight — Friday 22:00 to 02:00
 * is configured once as a Friday slot, not as two rows an enterprise has to
 * reason about.
 */
export const TimeSlotSchema = z.strictObject({
  /** ISO 1 = Monday … 7 = Sunday, matching Postgres EXTRACT(ISODOW). */
  days: z.array(z.number().int().min(ISO_MONDAY).max(ISO_SUNDAY)).min(1).max(7),
  start: WallClockSchema,
  end: WallClockSchema,
});

export const TimeWindowConfigSchema = z.strictObject({
  /**
   * Slots OR within this condition; conditions AND at the rule level. This is
   * the ONLY OR in the design, and it is contained inside one handler rather
   * than being a general boolean tree — which is what keeps us out of the
   * batched materialisation pipeline a predicate tree forces.
   */
  slots: z.array(TimeSlotSchema).min(1).max(32),
});

export const CustomerTenureConfigSchema = z.strictObject({
  /** They must have first engaged at least this long ago. */
  minDaysSinceFirstEngagement: z.number().int().positive().max(3650),
});

export const ContentMatchConfigSchema = z.strictObject({
  /** Case-insensitive. Matched, never summed, which is why this is JSONB. */
  anyOfKeywords: z.array(z.string().trim().min(1).max(60)).min(1).max(32),
});

export const RewardConditionConfigSchema = z.discriminatedUnion('conditionKind', [
  z.strictObject({
    conditionKind: z.literal(RewardConditionKind.TimeWindow),
    config: TimeWindowConfigSchema,
  }),
  z.strictObject({
    conditionKind: z.literal(RewardConditionKind.CustomerTenure),
    config: CustomerTenureConfigSchema,
  }),
  z.strictObject({
    conditionKind: z.literal(RewardConditionKind.ContentMatch),
    config: ContentMatchConfigSchema,
  }),
]);

export type RewardConditionConfig = z.infer<typeof RewardConditionConfigSchema>;

/* ========================================================================
 * Programs
 * ===================================================================== */

/**
 * EVERY TRIGGER, WHERE IT COMES FROM, AND WHETHER IT CAN ACTUALLY FIRE.
 *
 * One list, served to the client by `GET /rewards/triggers` and used by the
 * validation below. The portal used to carry its own copy with its own
 * availability flags — two lists that agree only until somebody builds a
 * producer and updates one of them.
 *
 * `available: false` means the trigger is MODELLED and has no producer: the
 * enum lists it so a rule referencing it is representable, and nothing in the
 * ingest path will ever raise it. A rule built on one would save and then
 * never fire, which is why it is refused below rather than merely greyed out
 * on a screen — a client is not the only way to reach this API.
 */
export const TRIGGER_CATALOGUE: readonly {
  readonly key: RewardTriggerKind;
  readonly group: 'instagram' | 'system';
  readonly label: string;
  readonly available: boolean;
}[] = [
  {
    key: RewardTriggerKind.DirectMessageInbound,
    group: 'instagram',
    label: 'Sent us a direct message',
    available: true,
  },
  {
    key: RewardTriggerKind.StoryMention,
    group: 'instagram',
    label: 'Mentioned us in their story',
    available: true,
  },
  {
    key: RewardTriggerKind.StoryReply,
    group: 'instagram',
    label: 'Replied to our story',
    available: true,
  },
  {
    key: RewardTriggerKind.CommentOnOwnPost,
    group: 'instagram',
    label: 'Commented on our post',
    available: true,
  },
  {
    key: RewardTriggerKind.CommentOnMentionedPost,
    group: 'instagram',
    label: 'Commented on a post tagging us',
    available: true,
  },
  {
    key: RewardTriggerKind.ReferralEntry,
    group: 'instagram',
    label: 'Arrived from an ad, link or QR code',
    available: true,
  },
  {
    key: RewardTriggerKind.PostbackTapped,
    group: 'instagram',
    label: 'Tapped a button',
    available: true,
  },
  {
    key: RewardTriggerKind.PostTaggingUs,
    group: 'instagram',
    label: 'Posted and tagged us',
    available: false,
  },
  {
    key: RewardTriggerKind.MessageReaction,
    group: 'instagram',
    label: 'Reacted to our message',
    available: false,
  },
  { key: RewardTriggerKind.OptInGranted, group: 'instagram', label: 'Opted in', available: false },
  {
    key: RewardTriggerKind.PostCaptionMention,
    group: 'instagram',
    label: 'Named us in a caption',
    available: false,
  },
  {
    key: RewardTriggerKind.PostLike,
    group: 'instagram',
    label: 'Liked our post',
    available: false,
  },
  {
    key: RewardTriggerKind.PostShare,
    group: 'instagram',
    label: 'Shared our post',
    available: false,
  },
  {
    key: RewardTriggerKind.PointsBalanceReached,
    group: 'system',
    label: 'Reached a points balance',
    available: true,
  },
];

/** Derived, never written twice. */
export const AVAILABLE_TRIGGERS: ReadonlySet<RewardTriggerKind> = new Set(
  TRIGGER_CATALOGUE.filter((t) => t.available).map((t) => t.key),
);

/**
 * WHICH TRIGGERS ARE SOCIAL, and which one is not.
 *
 * Every trigger but one is something a customer did on a platform: they sent
 * a message, commented, mentioned us, tapped a button. `points_balance_reached`
 * is raised by the engine itself after a credit moves a balance — it is an
 * internal transfer, not an interaction — and almost everything in the form
 * that makes sense for a social trigger makes none for it.
 *
 * Exported because the portal groups its checkboxes by exactly this split, and
 * a second copy of the list there would be a second thing to update.
 */
export const SYSTEM_TRIGGERS: ReadonlySet<RewardTriggerKind> = new Set([
  RewardTriggerKind.PointsBalanceReached,
]);

/**
 * Every reward, whether it can be chosen, and what it needs chosen with it.
 *
 * THE SAME IDEA AS `TRIGGER_CATALOGUE`, and here for the same reason: the
 * portal's dropdown and this validator must be one list or they will be two
 * lists, and the day they disagree is the day a screen greys something out
 * while the API happily stores it. A screen is not the only way to reach this
 * API.
 *
 * `available: false` — `issue_entitlement` is modelled end to end and has no
 * item catalogue behind it. `itemRef` is free text, so a business can promise
 * `FREE_COFFEE` with nothing in the system that knows what that is, nothing to
 * redeem it against, and nothing to stop a typo becoming a different reward.
 * Until there is something to point at, it is refused on save rather than
 * merely hidden — a stored promise nobody can keep is worse than a missing
 * option. (`docs/backlog.md` §2 holds what it is waiting for.)
 *
 * `requiresTrigger` — `convert_value` burns points and grants money in one
 * step, which only makes sense at the moment a balance is worth converting.
 * `docs/reward-programs-design.md` already says it: "conversion is a rule, not
 * a mechanism — 'when points reach 30, burn 30 and grant ₹50' is a trigger
 * plus a benefit". Hung off a DM instead, it would try to burn points the
 * customer may not have and silently award nothing, for ever.
 */
export const BENEFIT_CATALOGUE: readonly {
  readonly key: RewardBenefitKind;
  readonly label: string;
  readonly available: boolean;
  /** EMPTY = goes with anything. Otherwise: at least one of these triggers. */
  readonly requiresTrigger: readonly RewardTriggerKind[];
  /**
   * Whether the scoring factor may scale this down — whether "up to" is an
   * answer at all.
   *
   * MIRRORS THE HANDLER'S OWN `scalable`, which stays the authority: the
   * benefit registry refuses a non-scalable "up to" at the service layer.
   * This copy exists because a contract cannot import a service, and because
   * the portal has to know which rows may offer the choice. A test pins the
   * two together so the copy cannot drift from the thing it copies.
   */
  readonly scalable: boolean;
}[] = [
  {
    key: RewardBenefitKind.GrantPoints,
    label: 'Points',
    available: true,
    requiresTrigger: [],
    scalable: true,
  },
  {
    key: RewardBenefitKind.GrantCurrency,
    label: 'Money',
    available: true,
    requiresTrigger: [],
    scalable: true,
  },
  {
    key: RewardBenefitKind.IssueEntitlement,
    label: 'An item',
    available: false,
    requiresTrigger: [],
    /* Six tenths of a free coffee is nothing. */
    scalable: false,
  },
  {
    key: RewardBenefitKind.ConvertValue,
    label: 'Turn points into money',
    available: true,
    requiresTrigger: [RewardTriggerKind.PointsBalanceReached],
    /*
     * A CONVERSION IS A STATED EXCHANGE RATE. "Every 20 points becomes 2.00"
     * is a promise; letting a factor shave it would mean 20 points sometimes
     * bought 2.00 and sometimes 1.20, which is not a thing a business can
     * explain to a customer. Exactly, or not at all.
     */
    scalable: false,
  },
];

/**
 * WHERE THE VALUE ENDS UP, asked once for the whole programme.
 *
 * A programme-level choice rather than a per-reward one, because it is a
 * statement about where this business keeps value, not about what a
 * particular reward is. Two rewards in one programme paying into two
 * different systems would mean a customer's balance lived in two places with
 * nothing reconciling them.
 *
 * `internal` → `forward_provider_code` stays NULL: the value lives in Wouchh
 * wallets, which is everything that works today.
 *
 * `external` → the provider code is recorded on the programme, it is audited
 * and versioned like any other configuration, AND NOTHING IS FORWARDED YET.
 * The forwarding pipeline is designed in `docs/reward-programs-design.md` §13
 * — outbound_events, the transit leg, the provider interface — and none of it
 * is built: `RewardEntryKind.ForwardOut` is the only part of it that exists in
 * code. `'noop'` is the design's own name for the provider that records
 * intent and moves nothing.
 *
 * SAYING SO IS THE POINT. A toggle that looks like it forwards and silently
 * does not is the exact failure this codebase keeps finding under new names,
 * so the portal states what it does and this comment states why.
 */
export const REWARD_DESTINATIONS = ['internal', 'external'] as const;
export type RewardDestination = (typeof REWARD_DESTINATIONS)[number];

/** The design's V1 provider: records intent, moves nothing. */
export const NOOP_FORWARD_PROVIDER = 'noop';

/** Derived, never written twice. */
export const AVAILABLE_BENEFITS: ReadonlySet<RewardBenefitKind> = new Set(
  BENEFIT_CATALOGUE.filter((b) => b.available).map((b) => b.key),
);

/** The kinds a factor may scale. Everything else is "exactly" or nothing. */
export const SCALABLE_BENEFITS: ReadonlySet<RewardBenefitKind> = new Set(
  BENEFIT_CATALOGUE.filter((b) => b.scalable).map((b) => b.key),
);

const BENEFIT_TRIGGER_REQUIREMENT: ReadonlyMap<
  RewardBenefitKind,
  ReadonlySet<RewardTriggerKind>
> = new Map(
  BENEFIT_CATALOGUE.filter((b) => b.requiresTrigger.length > 0).map((b) => [
    b.key,
    new Set(b.requiresTrigger),
  ]),
);

/**
 * WHAT A REWARD ACTUALLY DOES, as a key — so two that do the same thing can be
 * recognised as two of the same thing.
 *
 * "Grant 20 points and grant 30 points" is not two rewards. It is one reward
 * of 50 written twice, and saving it that way gives a business two lines to
 * maintain, two lines to read in an audit trail, and one effect.
 *
 * KEYED ON THE EFFECT, NOT ON THE KIND, because those differ in one real case.
 * `grant_currency` may name its own currency — that is what the optional
 * `currencyCode` is for, a promotion paying in something other than the usual
 * — so two currency grants in DIFFERENT currencies pay into two different
 * wallets and are genuinely two rewards. Two in the same currency are not.
 * Keying on the kind alone would refuse the first case along with the second.
 *
 * `issue_entitlement` keys on the item: a free coffee and a free pastry are
 * different things to hand over.
 */
/* The config is typed `unknown` per key, and the schemas have already
 * guaranteed these two are strings by the time a refinement runs. Narrowing
 * rather than casting keeps that guarantee checked rather than asserted. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function benefitEffectKey(benefit: {
  benefitKind: RewardBenefitKind;
  config: Record<string, unknown>;
}): string {
  switch (benefit.benefitKind) {
    case RewardBenefitKind.GrantPoints:
      /* One points wallet per customer, so there is nothing to vary by. */
      return RewardBenefitKind.GrantPoints;
    case RewardBenefitKind.IssueEntitlement:
      return `${RewardBenefitKind.IssueEntitlement}:${text(benefit.config.itemRef)}`;
    default:
      /* Both money kinds: unstated currency means the business's, so an
       * unstated one and a stated one naming the same currency would be the
       * same wallet. They cannot be told apart here without reading the
       * business, and `assertMoneyHasACurrency` already refuses the case
       * where that matters, so unstated is its own key. */
      return `${benefit.benefitKind}:${text(benefit.config.currencyCode)}`;
  }
}

/** True when no two benefits would land in the same place. */
function benefitsAreDistinct(
  benefits: readonly { benefitKind: RewardBenefitKind; config: Record<string, unknown> }[],
): boolean {
  const seen = new Set<string>();
  for (const benefit of benefits) {
    const key = benefitEffectKey(benefit);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * Whether this reward may sit alongside these triggers.
 *
 * ONE FUNCTION, called from both the programme path and the rule path, because
 * the two differ only in how many triggers they hold — and a rule that is
 * refused one way in and accepted the other is not a rule.
 */
export function benefitSuitsTriggers(
  benefitKind: RewardBenefitKind,
  triggers: readonly RewardTriggerKind[],
): boolean {
  const required = BENEFIT_TRIGGER_REQUIREMENT.get(benefitKind);
  if (required === undefined) return true;
  return triggers.some((t) => required.has(t));
}

/**
 * The day-and-hours half of a schedule, shaped the way a person fills it in.
 *
 * ONE ENTRY PER DAY, each with its own hours, because that is how somebody
 * thinks about it: tick Friday, then say when on Friday. The engine's
 * `time_window` condition is the transpose — a list of slots, each naming the
 * days it applies to — and the service converts between them. Neither shape is
 * wrong; they are answers to different questions, and the conversion lives in
 * one place rather than in the client.
 */
export const ScheduleDaySchema = z.strictObject({
  isoDay: z.number().int().min(ISO_MONDAY).max(ISO_SUNDAY),
  /** Empty means the whole of that day. */
  slots: z
    .array(z.strictObject({ start: WallClockSchema, end: WallClockSchema }))
    .max(8)
    .default([]),
});

/**
 * When a programme runs, and when within that it applies.
 *
 * EVERY PART IS OPTIONAL and they are independent. No dates means "running
 * now, indefinitely". No days means "any day, any hour". Days with no slots
 * means "those days, all day". The absence of a restriction has to mean
 * ALWAYS rather than never — the opposite would silently disable every
 * programme nobody configured.
 */
export const ProgramScheduleSchema = z.strictObject({
  startsAt: z.coerce.date().nullable().default(null),
  endsAt: z.coerce.date().nullable().default(null),
  days: z.array(ScheduleDaySchema).max(7).default([]),
});

/**
 * Only the transitions a human makes.
 *
 * There is no `ended`: `endsAt` in the past already says it, and two columns
 * answering one question is the duplication schema.md rejects when it forbids
 * `deleted` inside any status enum.
 */
/**
 * Which programmes to list.
 *
 * Absent means the working set: everything except archived. Naming a status
 * returns exactly that status, which is how the portal's "archived" view asks
 * for the retired ones without a second endpoint.
 */
/**
 * How many versions of a program to return.
 *
 * BOUNDED, with a default, because an unbounded history read is a table scan
 * waiting for the first program that has been edited a thousand times. Coerced
 * from the query string, which arrives as text or not at all.
 */
export const HistoryLimitSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(MAX_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE);

export const RewardProgramQuerySchema = z.strictObject({
  status: z.enum(RewardProgramStatus).optional(),
});

export const UpdateRewardProgramStatusSchema = z.strictObject({
  status: z.enum([
    RewardProgramStatus.Active,
    RewardProgramStatus.Paused,
    RewardProgramStatus.Archived,
  ]),
});

/* ========================================================================
 * Rules
 * ===================================================================== */

const BenefitInputSchema = z.intersection(
  RewardBenefitConfigSchema,
  z.object({
    /**
     * Whether the factor may scale this benefit. The registry refuses `up_to`
     * on a discrete kind, because 0.6 of a free coffee means nothing.
     */
    awardMode: z.enum(RewardAwardMode).default(RewardAwardMode.Fixed),
    awardCap: z.number().int().positive().nullable().default(null),
  }),
);

/* ========================================================================
 * Programs — created whole, in one request
 *
 * DECLARED AFTER THE BENEFITS it embeds, because it embeds them: a programme
 * now arrives with its triggers and its rewards rather than as an empty shell
 * to be filled in by later calls.
 * ===================================================================== */

/**
 * A programme takes NEITHER a timezone NOR a currency any more.
 *
 * Both are facts about the BUSINESS, set once in business settings and read
 * from there by everything. Taken per programme, they were copied at creation
 * and never reconciled — so two programmes in one business could disagree
 * about when Tuesday starts and about what money means, with nothing to say
 * which was right.
 */
export const CreateRewardProgramSchema = z
  .strictObject({
    /**
     * THE INTERNAL NAME. Unique per business, case insensitively, because its
     * whole job is to let somebody say which programme they mean.
     */
    name: z.string().trim().min(1).max(120),
    /**
     * WHAT CUSTOMERS WILL SEE, and deliberately almost unvalidated.
     *
     * It is marketing copy: emoji, punctuation, mixed script, whatever the
     * business wants to be called in front of its customers. Not unique —
     * two programmes may both say "Rewards", and which one awarded is a
     * question for the ledger rather than the label.
     *
     * BOUNDED ANYWAY, because "no checks" cannot mean "no limit": an
     * unbounded string from a request body is a way to put a megabyte in a
     * row. Trimmed, and an empty string becomes NULL rather than being stored
     * as a name that renders as nothing.
     */
    displayName: z
      .string()
      .trim()
      .max(160)
      .transform((value) => (value.length === 0 ? null : value))
      .nullable()
      .default(null),
    /**
     * WHAT THE CUSTOMER HAS TO DO, as a set rather than one at a time.
     *
     * A rule carries exactly one trigger — that is the engine's shape and it
     * does not change. What changed is the conversation: somebody setting up
     * a programme thinks "reward DMs and story mentions", not "write two
     * rules". The service expands the set into one rule per trigger, in one
     * transaction, so a half-built programme cannot exist.
     *
     * OPTIONAL, because a programme may legitimately be created empty and
     * filled in later — and because every existing caller does exactly that.
     */
    triggers: z.array(z.enum(RewardTriggerKind)).max(14).default([]),
    /**
     * The balance that fires `points_balance_reached`. Required with it,
     * refused without it — see the refinements below.
     */
    minPointsBalance: z.number().int().positive().max(10_000_000).optional(),
    holdHours: z.number().int().min(0).max(720).default(0),
    capScope: z.enum(RewardCapScope).default(RewardCapScope.None),
    capCount: z.number().int().positive().max(1000).default(1),
    /*
     * NOT CONFIGURABLE FOR NOW.
     *
     * Taking an award back when the content behind it is deleted or hidden is
     * built — the column, the engine path and its tests all exist — and what
     * it should DO is not settled: whether a hidden comment is the same as a
     * deleted one, whether a customer who deletes and reposts earns twice,
     * whether reversing is right at all when the hold already covers the
     * common case. Offering the switch before those are answered is offering
     * a promise nobody has decided the shape of.
     *
     * So the field is gone from the wire and every rule is written `none`.
     * The machinery stays rather than being ripped out, because the decision
     * is deferred rather than reversed — see backlog.md §2.
     */
    /** Shared by every rule the triggers expand into. */
    benefits: z.array(BenefitInputSchema).max(16).default([]),
    /*
     * WHERE THE VALUE GOES — one answer for the programme, not one per
     * reward. Defaults to `internal`, which is the only one that moves
     * anything today; see `REWARD_DESTINATIONS`.
     */
    destination: z.enum(REWARD_DESTINATIONS).default('internal'),
    schedule: ProgramScheduleSchema.default({ startsAt: null, endsAt: null, days: [] }),
  })
  .refine(
    (v) =>
      v.schedule.startsAt === null ||
      v.schedule.endsAt === null ||
      v.schedule.startsAt < v.schedule.endsAt,
    {
      message: 'the end of the schedule must be after its start',
      path: ['schedule', 'endsAt'],
    },
  )
  /*
   * A TRIGGER THAT CANNOT FIRE IS REFUSED, not merely greyed out.
   *
   * Six of the fourteen are modelled with no producer: nothing in the ingest
   * path will ever raise them. The portal disables them, and a screen is not
   * the only way to reach this API — a rule built on one would save, report
   * success, and never award anything, which is the exact failure this
   * codebase keeps rediscovering under different names.
   */
  .refine((v) => v.triggers.every((t) => AVAILABLE_TRIGGERS.has(t)), {
    message:
      'that trigger is modelled but has no producer yet, so a rule using it could never fire',
    path: ['triggers'],
  })
  /*
   * THE SYSTEM TRIGGER STANDS ALONE.
   *
   * `points_balance_reached` is raised by the engine after a credit moves a
   * balance — an internal transfer rather than something a customer did. Put
   * in the same rule set as a social trigger it would mean "when they DM us
   * AND when their balance crosses 100", which is two unrelated programmes
   * wearing one name and sharing one cap.
   */
  .refine((v) => !v.triggers.some((t) => SYSTEM_TRIGGERS.has(t)) || v.triggers.length === 1, {
    message:
      'a points-balance programme cannot also be driven by social triggers — it is an internal transfer, not an interaction',
    path: ['triggers'],
  })
  /* Both directions, as on the rule: a threshold with no trigger to apply it
   * to reads as a condition the engine will never consult. */
  .refine(
    (v) =>
      v.triggers.includes(RewardTriggerKind.PointsBalanceReached) ===
      (v.minPointsBalance !== undefined),
    {
      message:
        'a balance to reach is required for points_balance_reached and means nothing on any other trigger',
      path: ['minPointsBalance'],
    },
  )
  /*
   * A HOLD IS A SOCIAL IDEA. It exists so a comment that is deleted an hour
   * later never pays out, which is a thing that can happen to a post and
   * cannot happen to a balance crossing — nobody un-earns points by deleting
   * something.
   */
  .refine((v) => v.holdHours === 0 || !v.triggers.some((t) => SYSTEM_TRIGGERS.has(t)), {
    message:
      'a hold only means something for a social trigger; a balance crossing cannot be undone',
    path: ['holdHours'],
  })
  /* A programme with triggers but nothing to award is a programme that does
   * nothing, loudly rather than quietly. */
  .refine((v) => v.triggers.length === 0 || v.benefits.length > 0, {
    message: 'choose at least one reward, or the triggers award nothing',
    path: ['benefits'],
  })
  /*
   * AND THE OTHER DIRECTION, which was silently wrong.
   *
   * `createProgram` builds one rule PER TRIGGER and hangs the benefits off
   * each. With no triggers there is no rule, so the benefits were accepted,
   * validated, reported back in a 201 — and dropped. Somebody would fill in
   * "20 points", save, see success, and own a programme that awards nothing.
   */
  .refine((v) => v.benefits.length === 0 || v.triggers.length > 0, {
    message: 'rewards need a trigger to hang off; with none, nothing would ever award them',
    path: ['benefits'],
  })
  /*
   * A REWARD NOTHING CAN DELIVER IS NOT STORABLE. Same bargain as the trigger
   * list above, and the same reason: the portal greys it out, and the portal
   * is not the only way in.
   */
  .refine((v) => v.benefits.every((b) => AVAILABLE_BENEFITS.has(b.benefitKind)), {
    message:
      'that reward is modelled but has nothing behind it yet, so it could be promised and never honoured',
    path: ['benefits'],
  })
  /* `convert_value` needs the balance trigger — see `BENEFIT_CATALOGUE`. */
  .refine((v) => v.benefits.every((b) => benefitSuitsTriggers(b.benefitKind, v.triggers)), {
    message:
      'turning points into money only means something when the trigger is the balance itself — pick "reached a points balance"',
    path: ['benefits'],
  })
  /*
   * "UP TO" ONLY WHERE THERE IS SOMETHING TO SCALE.
   *
   * The service refuses this too, through the registry, and that refusal is
   * the authoritative one because the handler declares its own scalability.
   * It is here as well so the answer is a 422 naming the field rather than a
   * business-rule exception thrown halfway through a transaction — and so the
   * rule lives in the same place as the form rule it mirrors.
   */
  .refine(
    (v) =>
      v.benefits.every(
        (b) => b.awardMode !== RewardAwardMode.UpTo || SCALABLE_BENEFITS.has(b.benefitKind),
      ),
    {
      message: 'this reward cannot be "up to" — it is exact or it is nothing',
      path: ['benefits'],
    },
  )
  /*
   * TWO REWARDS THAT DO THE SAME THING ARE ONE REWARD WRITTEN TWICE.
   *
   * Refused rather than merged: merging would mean the stored configuration
   * is not the one that was sent, and somebody who meant 20 and 30 to be two
   * separate lines for two separate reasons would find one line of 50 and no
   * record of why.
   */
  .refine(
    (v) =>
      benefitsAreDistinct(
        v.benefits.map((b) => ({
          benefitKind: b.benefitKind,
          config: b.config as Record<string, unknown>,
        })),
      ),
    {
      message: 'two rewards here do the same thing — combine them into one, or make them different',
      path: ['benefits'],
    },
  );

/**
 * What a trigger matches on, beyond its kind.
 *
 * STRICT, and deliberately small. The previous shape was an open record
 * documented as "matched" and matched by NOTHING: a business could save
 * `{"postbackPayload":"WELCOME"}`, see it stored, see it read back, and never
 * learn that the engine ignored it. Two keys are honoured, so two keys are
 * accepted — anything else is a 400 rather than a rule that quietly fires on
 * everything.
 */
export const RewardTriggerConfigSchema = z.strictObject({
  /** Only these channels. ABSENT MEANS EVERY CHANNEL the business owns. */
  channelIds: z.array(z.number().int().positive()).min(1).max(50).optional(),
  /** `points_balance_reached` only, and required there — see the refinements. */
  minPointsBalance: z.number().int().positive().max(10_000_000).optional(),
});
export type RewardTriggerConfig = z.infer<typeof RewardTriggerConfigSchema>;

export const CreateRewardRuleSchema = z
  .strictObject({
    programRefId: z.uuid(),
    triggerKind: z.enum(RewardTriggerKind),
    /** Narrows the trigger. Matched, never summed. */
    triggerConfig: RewardTriggerConfigSchema.default({}),
    capScope: z.enum(RewardCapScope).default(RewardCapScope.None),
    capCount: z.number().int().positive().max(1000).default(1),
    /** Doubles as the reversal window and the factor's settling time. */
    holdHours: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 30)
      .default(0),
    priority: z.number().int().min(0).max(10_000).default(0),
    /** An EMPTY list means ALWAYS — never "never". */
    conditions: z.array(RewardConditionConfigSchema).max(16).default([]),
    /** At least one: a rule that awards nothing is a rule that does nothing. */
    benefits: z.array(BenefitInputSchema).min(1).max(16),
  })
  /* Same rule as the programme path: a trigger with no producer cannot fire,
   * so a rule may not be built on one. */
  .refine((v) => AVAILABLE_TRIGGERS.has(v.triggerKind), {
    message: 'that trigger is modelled but has no producer yet, so this rule could never fire',
    path: ['triggerKind'],
  })
  .refine((v) => v.capScope !== RewardCapScope.None || v.capCount === 1, {
    message: 'capCount only means something with a capScope',
    path: ['capCount'],
  })
  /*
   * BOTH DIRECTIONS, and both are real mistakes. A threshold trigger with no
   * threshold would fire at any balance above zero and grant endlessly; a
   * threshold on any other trigger reads as a condition the engine will never
   * apply.
   */
  .refine(
    (v) =>
      (v.triggerKind === RewardTriggerKind.PointsBalanceReached) ===
      (v.triggerConfig.minPointsBalance !== undefined),
    {
      message:
        'minPointsBalance is required for points_balance_reached and means nothing on any other trigger',
      path: ['triggerConfig', 'minPointsBalance'],
    },
  )
  /* A balance crossing happens in no channel, so scoping one to a channel
   * would silently match nothing. */
  .refine(
    (v) =>
      v.triggerKind !== RewardTriggerKind.PointsBalanceReached ||
      v.triggerConfig.channelIds === undefined,
    {
      message: 'points_balance_reached is not a channel event and cannot be scoped to channels',
      path: ['triggerConfig', 'channelIds'],
    },
  )
  /* The same two reward rules as the programme path, because this is the same
   * rule arriving by a different door. */
  .refine((v) => v.benefits.every((b) => AVAILABLE_BENEFITS.has(b.benefitKind)), {
    message:
      'that reward is modelled but has nothing behind it yet, so it could be promised and never honoured',
    path: ['benefits'],
  })
  .refine((v) => v.benefits.every((b) => benefitSuitsTriggers(b.benefitKind, [v.triggerKind])), {
    message:
      'turning points into money only means something when the trigger is the balance itself',
    path: ['benefits'],
  })
  .refine(
    (v) =>
      v.benefits.every(
        (b) => b.awardMode !== RewardAwardMode.UpTo || SCALABLE_BENEFITS.has(b.benefitKind),
      ),
    {
      message: 'this reward cannot be "up to" — it is exact or it is nothing',
      path: ['benefits'],
    },
  )
  .refine(
    (v) =>
      benefitsAreDistinct(
        v.benefits.map((b) => ({
          benefitKind: b.benefitKind,
          config: b.config as Record<string, unknown>,
        })),
      ),
    {
      message: 'two rewards here do the same thing — combine them into one, or make them different',
      path: ['benefits'],
    },
  );

/**
 * Switching a rule on or off.
 *
 * STRICT, AND THE BOOLEAN IS REQUIRED. This route had no schema at all: it read
 * `body?.isActive === true`, so `{"isActive":"true"}`, `{"active":true}`, `{}`
 * and a missing body every one of them coerced to FALSE and returned 200 — a
 * silent deactivation of a rule that decides who receives money, reported to
 * the caller as success. A typo switched off a money rule and said OK.
 */
export const UpdateRewardRuleActiveSchema = z.strictObject({
  isActive: z.boolean(),
});

/**
 * Which program's rules to list.
 *
 * `programRefId` is REQUIRED here, unlike in the general query below: the route
 * lists the rules OF a program, and without one the handler fell through to a
 * repository lookup with an empty string and a Postgres 22P02 — a client's
 * malformed input answering 500.
 */
export const RewardRuleListQuerySchema = z.strictObject({
  programRefId: z.uuid('expected a program reference id'),
});

/* ========================================================================
 * Balances and manual adjustment
 * ===================================================================== */

/**
 * A manual credit or debit against ONE customer's balance.
 *
 * Behind `rewards.adjust`, which is deliberately not `rewards.manage`: writing
 * a rule changes what everybody earns in future, while this moves value for a
 * named person now. The reason is required and lands in both the audit log and
 * the ledger entry, because the ledger must stand alone when Finance reads it
 * without the audit table beside it.
 */
export const AdjustRewardBalanceSchema = z
  .strictObject({
    customerRefId: z.uuid(),
    walletKind: z.enum(RewardWalletKind),
    currencyCode: CurrencyCodeSchema.nullable().default(null),
    /** SIGNED. Negative is a debit. Whole points, or minor units. */
    amount: z
      .number()
      .int()
      .refine((v) => v !== 0, 'an adjustment of zero does nothing'),
    reason: z.string().trim().min(1).max(255),
  })
  .refine((v) => (v.walletKind === RewardWalletKind.Points) === (v.currencyCode === null), {
    message: 'points carry no currency; currency requires one',
    path: ['currencyCode'],
  });

/**
 * EDITING A PROGRAMME IS RESTATING IT, which is why this is the create shape.
 *
 * A PUT, not a PATCH, and deliberately. The form that edits a programme is the
 * form that created it: every field is on screen, so every field is in the
 * body, and "what the user is looking at" and "what will be stored" are the
 * same thing. A partial update would make an omitted field ambiguous — cleared
 * or untouched? — for a configuration that decides who receives money.
 *
 * The same refinements apply for the same reasons: an edit cannot put a
 * programme into a state a creation could not.
 */
export const UpdateRewardProgramSchema = CreateRewardProgramSchema;

export type CreateRewardProgramInput = z.infer<typeof CreateRewardProgramSchema>;
export type UpdateRewardProgramInput = z.infer<typeof UpdateRewardProgramSchema>;
export type CreateRewardRuleInput = z.infer<typeof CreateRewardRuleSchema>;
export type AdjustRewardBalanceInput = z.infer<typeof AdjustRewardBalanceSchema>;
export type RewardBenefitInput = z.infer<typeof BenefitInputSchema>;
