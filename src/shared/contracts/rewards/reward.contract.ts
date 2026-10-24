import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/shared/constants';
import {
  ISO_MONDAY,
  ISO_SUNDAY,
  RewardAwardMode,
  RewardBenefitKind,
  RewardCapScope,
  RewardConditionKind,
  RewardProgramStatus,
  RewardReversalPolicy,
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
const CurrencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'ISO 4217 alphabetic code');

/* ========================================================================
 * Benefits — what the customer gets
 * ===================================================================== */

export const GrantPointsConfigSchema = z.strictObject({
  /** WHOLE points. Never a minor unit, never a float. */
  points: z.number().int().positive(),
});

export const GrantCurrencyConfigSchema = z.strictObject({
  minorUnits: MinorUnitsSchema.refine((v) => v > 0, 'must be positive'),
  currencyCode: CurrencyCodeSchema,
});

export const IssueEntitlementConfigSchema = z.strictObject({
  itemRef: z.string().trim().min(1).max(64),
  /** Null = never expires. */
  validForDays: z.number().int().positive().max(3650).nullable().default(null),
});

export const ConvertValueConfigSchema = z.strictObject({
  burnPoints: z.number().int().positive(),
  grantMinor: MinorUnitsSchema.refine((v) => v > 0, 'must be positive'),
  currencyCode: CurrencyCodeSchema,
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

export const CreateRewardProgramSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    /**
     * Resolves `period_key` AND every time window. Validated against the
     * runtime's own zone list rather than a hardcoded array, so it cannot go
     * stale when the tz database updates.
     */
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'not a recognised IANA timezone'),
    defaultCurrencyCode: CurrencyCodeSchema.nullable().default(null),
    startsAt: z.coerce.date().nullable().default(null),
    endsAt: z.coerce.date().nullable().default(null),
  })
  .refine((v) => v.startsAt === null || v.endsAt === null || v.startsAt < v.endsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
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
    reversalPolicy: z.enum(RewardReversalPolicy).default(RewardReversalPolicy.None),
    priority: z.number().int().min(0).max(10_000).default(0),
    /** An EMPTY list means ALWAYS — never "never". */
    conditions: z.array(RewardConditionConfigSchema).max(16).default([]),
    /** At least one: a rule that awards nothing is a rule that does nothing. */
    benefits: z.array(BenefitInputSchema).min(1).max(16),
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
