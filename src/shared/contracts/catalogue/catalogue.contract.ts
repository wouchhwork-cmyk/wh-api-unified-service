import { z } from 'zod';
import { MAX_PAGE_SIZE } from '@/shared/constants';
import { PostKind, PostStatus, Platform } from '@/shared/enums';

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

export type CustomerIdentityUpdate = z.infer<typeof CustomerIdentityUpdateSchema>;
export type PostFeedQuery = z.infer<typeof PostFeedQuerySchema>;
export type CustomerDirectoryQuery = z.infer<typeof CustomerDirectoryQuerySchema>;
