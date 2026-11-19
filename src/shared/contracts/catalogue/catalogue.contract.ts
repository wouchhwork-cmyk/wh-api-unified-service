import { z } from 'zod';
import { MAX_PAGE_SIZE } from '@/shared/constants';
import { IdentifierKind, PostKind, PostStatus, Platform } from '@/shared/enums';

/**
 * Every list input is bounded and allowlisted. `limit` is capped rather than
 * trusted, and `cursor` is opaque — a client that invents one gets the first
 * page, not an error, because the value is ours and means nothing to them.
 */
export const PostFeedQuerySchema = z
  .object({
    channelRefId: z.uuid().optional(),
    limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export const PostSummarySchema = z.object({
  refId: z.uuid(),
  platform: z.enum(Platform),
  postKind: z.enum(PostKind),
  status: z.enum(PostStatus),
  caption: z.string().nullable(),
  permalinkUrl: z.string().nullable(),
  publishedAt: z.date().nullable(),
  commentCount: z.number().int(),
  likeCount: z.number().int(),
  /** Facebook only; Instagram exposes no share count, so it stays 0 there. */
  shareCount: z.number().int(),
  channelRefId: z.uuid(),
  channelName: z.string().nullable(),
  media: z
    .object({
      url: z.string().optional(),
      thumbnailUrl: z.string().optional(),
      type: z.string().optional(),
    })
    .nullable(),
});

export const CustomerDirectoryQuerySchema = z
  .object({
    /**
     * Trimmed and length-bounded: it reaches a trigram ILIKE, and an unbounded
     * pattern is a way to make the database work hard for one request.
     */
    search: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export const CustomerSummarySchema = z.object({
  refId: z.uuid(),
  displayName: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  /** A platform handle, when the platform issues one. Facebook does not. */
  handle: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  firstSource: z.string().nullable(),
  conversationCount: z.number().int(),
  firstSeenAt: z.date().nullable(),
  lastSeenAt: z.date().nullable(),
  status: z.string(),
  isBlocked: z.boolean(),
});

/**
 * The name THIS BUSINESS gives somebody, which outranks the platform's.
 *
 * EVERY FIELD IS NULLABLE AND MEANS SOMETHING WHEN NULL. Clearing a name is
 * not the same as leaving it alone: it hands the customer back to whatever
 * Instagram calls them, which is exactly what somebody who typed a name by
 * mistake wants. So null is "use the platform's" and absent is "do not
 * touch", and the two are kept apart rather than collapsed.
 *
 * Trimmed, and an empty string is read as null: a name of spaces would
 * otherwise outrank the platform's and show as a blank row forever.
 */
export const CustomerIdentityUpdateSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .max(255)
      .transform((value) => (value.length === 0 ? null : value))
      .nullable()
      .optional(),
    firstName: z
      .string()
      .trim()
      .max(100)
      .transform((value) => (value.length === 0 ? null : value))
      .nullable()
      .optional(),
    lastName: z
      .string()
      .trim()
      .max(100)
      .transform((value) => (value.length === 0 ? null : value))
      .nullable()
      .optional(),
  })
  .strict()
  /* A request that changes nothing is a mistake worth naming rather than a
   * no-op worth auditing. */
  .refine((value) => Object.keys(value).length > 0, {
    message: 'nothing to change',
  });

/**
 * Which contact details a colleague may put on a record by hand.
 *
 * THREE KINDS, NOT EVERY KIND. The other identifier kinds are platform
 * scoped ids and handles — how a conversation is addressed, not a detail
 * anybody types — and letting a form write one would let somebody re-point
 * a thread at the wrong person.
 */
export const ContactKindSchema = z.enum([
  IdentifierKind.Mobile,
  IdentifierKind.WhatsAppNumber,
  IdentifierKind.Email,
]);

/**
 * Adding or correcting one contact detail.
 *
 * THE VALUE IS DELIBERATELY LOOSE HERE. This checks it is a sane string;
 * whether it is a real phone number is `cleanContact`'s job, and it needs
 * the country to say. A zod regex for phone numbers would reject valid ones
 * and accept nonsense, and would be a SECOND opinion about what a number is
 * — which is exactly how the stored shape drifts from the assistant's.
 */
export const CustomerContactSchema = z
  .object({
    kind: ContactKindSchema,
    value: z.string().trim().min(3).max(320),
    /**
     * ISO 3166-1 alpha-2, when somebody knows it. Omitted, a bare national
     * number is read as belonging to this business's own country and the
     * response says so.
     */
    country: z
      .string()
      .trim()
      .length(2)
      .regex(/^[A-Za-z]{2}$/, 'expected a two-letter country code')
      .optional(),
    /**
     * The existing value being corrected, exactly as the record shows it.
     * Absent means add; present means replace, which releases the old one.
     */
    replaces: z.string().trim().min(3).max(320).optional(),
  })
  .strict();

/** Taking one off the record. */
export const CustomerContactRemovalSchema = z
  .object({
    kind: ContactKindSchema,
    value: z.string().trim().min(3).max(320),
  })
  .strict();

/**
 * Raising or clearing "somebody here needs a person".
 *
 * A REASON ONLY WHEN RAISING. Clearing is a colleague saying they have dealt
 * with it, and attaching a reason to that would invite a second meaning for
 * the same field.
 */
export const CustomerNeedsHumanSchema = z
  .object({
    needsHuman: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * Stopping the assistant for one person, or starting it again.
 *
 * `resumesAt` IS BOUNDED, not free. A pause measured in weeks is somebody
 * forgetting rather than deciding, and an assistant silently off is
 * indistinguishable from a broken one — so the far end is a day, and
 * anything longer is a conversation to have about the business switch
 * instead.
 */
export const CustomerAutomationPauseSchema = z
  .object({
    paused: z.boolean(),
    /** ISO 8601. Omitted means until somebody turns it back on by hand. */
    resumesAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .refine(
        (value) => {
          if (value === undefined) return true;
          const at = new Date(value).getTime();
          const day = 24 * 60 * 60 * 1000;
          return at > Date.now() && at <= Date.now() + day;
        },
        { message: 'resumesAt must be in the future and within the next 24 hours' },
      ),
  })
  .strict();

export type CustomerNeedsHumanInput = z.infer<typeof CustomerNeedsHumanSchema>;
export type CustomerAutomationPauseInput = z.infer<typeof CustomerAutomationPauseSchema>;
export type CustomerContactInput = z.infer<typeof CustomerContactSchema>;
export type CustomerContactRemoval = z.infer<typeof CustomerContactRemovalSchema>;
export type CustomerIdentityUpdate = z.infer<typeof CustomerIdentityUpdateSchema>;
export type PostFeedQuery = z.infer<typeof PostFeedQuerySchema>;
export type CustomerDirectoryQuery = z.infer<typeof CustomerDirectoryQuerySchema>;
