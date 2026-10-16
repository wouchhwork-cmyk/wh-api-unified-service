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
    /**
     * One kind of thread only. Validated against the enum rather than passed
     * through, so an unknown value is a 400 and never reaches a query.
     */
    kind: z.enum(ConversationKind).optional(),
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
    /**
     * Answer ONE message in particular, the way the customer can answer ours.
     * The ref_id of a message in this same conversation; the platform is given
     * that message's own id. Absent means an ordinary reply to the thread.
     */
    replyToMessageRefId: z.uuid().optional(),
  })
  .strict()
  /*
   * A note answers nothing on the platform — it is a record for colleagues, and
   * never sent. Asking to thread one is a malformed request rather than
   * something to accept and quietly ignore, so it is refused here as a
   * validation error rather than deeper as a conflict.
   */
  .refine((value) => !(value.internalNote && value.replyToMessageRefId !== undefined), {
    message: 'an internal note cannot reply to a specific message',
    path: ['replyToMessageRefId'],
  });

export const ReplyResponseSchema = z.object({
  messageRefId: z.uuid(),
  status: z.enum(MessageStatus),
});

/**
 * Moderating one comment on a post we own.
 *
 * An enum rather than three endpoints: the three actions share every guard —
 * the same ownership proof, the same target lookup, the same outbox write — and
 * splitting them would have triplicated all of it.
 */
export const ModerateCommentRequestSchema = z
  .object({ action: z.enum(['hide', 'unhide', 'delete']) })
  .strict();

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
export type ModerateCommentRequest = z.infer<typeof ModerateCommentRequestSchema>;
export type AssignRequest = z.infer<typeof AssignRequestSchema>;
export type StatusRequest = z.infer<typeof StatusRequestSchema>;
