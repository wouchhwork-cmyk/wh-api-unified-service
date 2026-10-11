import { MESSAGING_WINDOW_MS } from '@/shared/constants';
import {
  ConversationKind,
  ConversationStatus,
  MentionKind,
  OutboundEventType,
} from '@/shared/enums';

/**
 * Statuses that refuse a customer-facing reply.
 *
 * `archived` used to be the only one the reply path checked, so a resolved or
 * closed conversation was still repliable — and CONVERSATION_CLOSED existed as
 * an error code nothing could raise.
 */
export const CLOSED_TO_REPLIES: ReadonlySet<ConversationStatus> = new Set([
  ConversationStatus.Resolved,
  ConversationStatus.Closed,
  ConversationStatus.Archived,
]);

/**
 * How a reply to each kind of conversation reaches the platform.
 *
 * A full Record, so adding a ConversationKind will not compile until someone
 * says how to answer it. This replaced a two-way ternary that sent everything
 * except a comment thread as a DIRECT MESSAGE — which meant a reply to a
 * MENTION was addressed to a comment id as though it were a person, and Meta
 * refused it. Mentions really are created: the projector wires
 * InboundEventType.Mention straight through to a mention conversation.
 *
 * Null means the platform offers us no way to answer that kind at all.
 */
const REPLY_EVENT_TYPE: Readonly<Record<ConversationKind, OutboundEventType | null>> = {
  [ConversationKind.DirectMessage]: OutboundEventType.DirectMessage,
  [ConversationKind.CommentThread]: OutboundEventType.CommentReply,
  /*
   * A mention is a comment on SOMEONE ELSE'S post, and that is exactly why it
   * cannot be answered as one: `POST /{comment-id}/replies` only works on media
   * we own. Meta gives a dedicated mentions edge for this, so the reply is
   * routed there instead — see docs/platform-limitations.md §1.6.
   */
  [ConversationKind.Mention]: OutboundEventType.MentionReply,
  /** Reviews are read-only on the Graph surfaces this service uses. */
  [ConversationKind.Review]: null,
};

/**
 * The 24-hour rule applies to MESSAGING, so it applies to every kind that is
 * delivered as a message — a story reply included. A comment can be answered
 * years later.
 */
const WINDOWED_KINDS: ReadonlySet<ConversationKind> = new Set([
  ConversationKind.DirectMessage,
]);

/** What sending a reply to this conversation would enqueue, or null if nothing can. */
export function replyEventTypeFor(kind: ConversationKind): OutboundEventType | null {
  return REPLY_EVENT_TYPE[kind] ?? null;
}

export interface ReplyWindow {
  readonly canReply: boolean;
  /** Why not, in words an agent can act on. Null when a reply is allowed. */
  readonly reason: string | null;
}

/**
 * Whether a reply can reach the platform right now.
 *
 * Only MESSAGE-delivered kinds have a window. A comment can be answered years
 * later, so applying the same rule to comment threads would block replies the
 * platform accepts perfectly well — which is why this branches on kind rather
 * than treating every conversation as a message thread.
 *
 * `lastInboundAt` null means the customer has never written to us. Meta does not
 * allow a business to open a message thread, so there is nothing to reply to.
 *
 * Pure and time-injected: the boundary is exactly the kind of logic that is
 * untestable once it reads the clock itself.
 */
export function evaluateReplyWindow(input: {
  /**
   * HOW we were tagged, for a mention. Read from `context_metadata`, where the
   * projector and the /tags backfill both file it.
   */
  mentionKind?: unknown;
  conversationKind: ConversationKind;
  lastInboundAt: Date | null;
  /** Omitted by callers that only care about the platform's own rules. */
  status?: ConversationStatus;
  now?: Date;
}): ReplyWindow {
  /*
   * A CLOSED THREAD FIRST, before any platform rule.
   *
   * Told to the client rather than only enforced on it: the reply endpoint
   * refuses these, and a reply box that accepts text and then answers 409 is
   * worse than one that explains up front why it is disabled.
   */
  if (input.status !== undefined && CLOSED_TO_REPLIES.has(input.status)) {
    return {
      canReply: false,
      reason: `This conversation is ${input.status}. Reopen it to reply, or add an internal note.`,
    };
  }

  // Answered first, and separately from the window: "no reply is possible here"
  // is a different fact from "not right now", and an agent needs to be told
  // which one they are looking at.
  if (replyEventTypeFor(input.conversationKind) === null) {
    return {
      canReply: false,
      reason:
        'The platform does not accept replies to this kind of item. You can still add an internal note.',
    };
  }

  /*
   * A COLLABORATOR OR PHOTO TAG CANNOT BE ANSWERED AT ALL.
   *
   * The right to comment on somebody else's post tracks `mentioned_media`
   * access exactly, and only a CAPTION tag grants it. Measured against live
   * posts (platform-limitations 1.7b): a caption tag takes a top-level comment
   * with a 200, a comment mention takes a reply beneath that comment, and a
   * collaborator or photo tag refuses both with `#200 Permissions error` —
   * every time, with the same token, seconds apart.
   *
   * This was documented and not enforced, which is the worst of both: an agent
   * was offered a reply box on a tagged post, and the send went 202, queued,
   * spent its attempts and dead-lettered — telling them it had failed long
   * after they had moved on. The platform's answer is knowable here, so it is
   * given here.
   */
  if (
    input.conversationKind === ConversationKind.Mention &&
    input.mentionKind === MentionKind.Tagged
  ) {
    return {
      canReply: false,
      reason:
        'Instagram does not allow replying to a post you were tagged in — only to one that ' +
        '@mentions you in its caption or in a comment. You can still add an internal note.',
    };
  }

  if (!WINDOWED_KINDS.has(input.conversationKind)) {
    return { canReply: true, reason: null };
  }

  if (!input.lastInboundAt) {
    return {
      canReply: false,
      reason:
        'This person has not messaged yet, and a business cannot open a message thread. Wait for them to write first.',
    };
  }

  const now = input.now ?? new Date();
  const elapsed = now.getTime() - input.lastInboundAt.getTime();

  if (elapsed > MESSAGING_WINDOW_MS) {
    const hours = Math.floor(elapsed / (60 * 60 * 1000));
    return {
      canReply: false,
      reason:
        `The platform only accepts a reply within 24 hours of the customer's last message, and ` +
        `theirs was ${hours} hours ago. You can still add an internal note.`,
    };
  }

  return { canReply: true, reason: null };
}
