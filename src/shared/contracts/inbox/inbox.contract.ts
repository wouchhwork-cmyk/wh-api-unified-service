import { z } from 'zod';
import { ConversationKind, ConversationStatus, MessageStatus } from '@/shared/enums';
import {
  MAX_IDEMPOTENCY_KEY_CHARS,
  MAX_MESSAGE_BODY_CHARS,
  MAX_PAGE_SIZE,
  MIN_IDEMPOTENCY_KEY_CHARS,
} from '@/shared/constants';

/** Filter values come from an allowlist, never raw from the client into SQL. */
export const InboxQuerySchema = z
  .object({
    status: z.enum(ConversationStatus).optional(),
    assignedToMe: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export const ThreadQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
    /** Opaque, from the previous page's `pagination.nextCursor`. */
    cursor: z.string().max(512).optional(),
    /**
     * DEPRECATED, kept so existing callers keep working: a bare id cannot page
     * this list, because the thread is ordered on the platform's timestamp and
     * ids are assigned at insert time. The service translates it into a real
     * keyset. Use `cursor`.
     */
    beforeId: z.coerce.number().int().positive().optional(),
  })
  .strict();

export const ReplyRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(MAX_MESSAGE_BODY_CHARS),
    /**
     * Client-supplied, so a double-click or a retry after a timeout cannot post
     * twice. Backed by a unique index, not an in-memory cache.
     *
     * REQUIRED. It was optional, which meant the one write in this service that
     * reaches a customer had no idempotency at all unless the caller opted in —
     * and "send the reply twice" is the failure this whole mechanism exists to
     * prevent. Mint it once per composed message and reuse it for every retry of
     * that message; a fresh key per attempt protects nothing.
     */
    idempotencyKey: z.string().trim().min(MIN_IDEMPOTENCY_KEY_CHARS).max(MAX_IDEMPOTENCY_KEY_CHARS),
    /** A team-only note. Never sent, never touches the ledger. */
    internalNote: z.boolean().default(false),
  })
  .strict();

export const ReplyResponseSchema = z.object({
  messageRefId: z.uuid(),
  status: z.enum(MessageStatus),
});

export const AssignRequestSchema = z
  .object({
    /** null unassigns. */
    employeeRefId: z.uuid().nullable(),
  })
  .strict();

export const StatusRequestSchema = z.object({ status: z.enum(ConversationStatus) }).strict();

/**
 * Marking a thread read takes no input, and says so.
 *
 * It was the one mutation with no schema at all, so any body was accepted and
 * silently ignored — which is how a client comes to send a field it believes is
 * doing something. `.strict()` on an empty object refuses it instead.
 */
export const MarkReadRequestSchema = z.object({}).strict();

export const ConversationSummarySchema = z.object({
  refId: z.uuid(),
  /** Null when nobody has picked it up yet. */
  assignedTo: z.object({ refId: z.uuid(), name: z.string().nullable() }).nullable(),
  conversationKind: z.enum(ConversationKind),
  status: z.enum(ConversationStatus),
  unreadCount: z.number().int(),
  messageCount: z.number().int(),
  lastMessageAt: z.date().nullable(),
});

export type InboxQuery = z.infer<typeof InboxQuerySchema>;
export type ThreadQuery = z.infer<typeof ThreadQuerySchema>;
export type ReplyRequest = z.infer<typeof ReplyRequestSchema>;
export type ReplyResponse = z.infer<typeof ReplyResponseSchema>;
export type AssignRequest = z.infer<typeof AssignRequestSchema>;
export type StatusRequest = z.infer<typeof StatusRequestSchema>;
