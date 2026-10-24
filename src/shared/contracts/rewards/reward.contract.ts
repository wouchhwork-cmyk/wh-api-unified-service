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
  });

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

export type CreateRewardProgramInput = z.infer<typeof CreateRewardProgramSchema>;
export type CreateRewardRuleInput = z.infer<typeof CreateRewardRuleSchema>;
export type AdjustRewardBalanceInput = z.infer<typeof AdjustRewardBalanceSchema>;
export type RewardBenefitInput = z.infer<typeof BenefitInputSchema>;
