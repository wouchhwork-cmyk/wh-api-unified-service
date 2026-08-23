import { MESSAGING_WINDOW_MS } from '@/shared/constants';
import { ConversationKind, OutboundEventType } from '@/shared/enums';

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
  /** A story reply arrives in, and is answered in, the message thread. */
  [ConversationKind.StoryReply]: OutboundEventType.DirectMessage,
  [ConversationKind.CommentThread]: OutboundEventType.CommentReply,
  /** A mention IS a comment — on someone else's post. Answered as one. */
  [ConversationKind.Mention]: OutboundEventType.CommentReply,
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
  ConversationKind.StoryReply,
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
  conversationKind: ConversationKind;
  lastInboundAt: Date | null;
  now?: Date;
}): ReplyWindow {
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
