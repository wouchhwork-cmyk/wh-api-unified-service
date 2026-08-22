import { MESSAGING_WINDOW_MS } from '@/shared/constants';
import { ConversationKind } from '@/shared/enums';

export interface ReplyWindow {
  readonly canReply: boolean;
  /** Why not, in words an agent can act on. Null when a reply is allowed. */
  readonly reason: string | null;
}

/**
 * Whether a reply can reach the platform right now.
 *
 * ONLY direct messages have a window. A comment can be answered years later, so
 * applying the same rule to comment threads would block replies the platform
 * accepts perfectly well — which is why this branches on kind rather than
 * treating every conversation as a message thread.
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
  if (input.conversationKind !== ConversationKind.DirectMessage) {
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
