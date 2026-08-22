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
  channelRefId: z.uuid(),
  channelName: z.string().nullable(),
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
  avatarUrl: z.string().nullable(),
  firstSource: z.string().nullable(),
  conversationCount: z.number().int(),
  firstSeenAt: z.date().nullable(),
  lastSeenAt: z.date().nullable(),
  status: z.string(),
  isBlocked: z.boolean(),
});

export type PostFeedQuery = z.infer<typeof PostFeedQuerySchema>;
export type CustomerDirectoryQuery = z.infer<typeof CustomerDirectoryQuerySchema>;
