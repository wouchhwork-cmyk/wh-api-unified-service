import { describe, expect, it } from 'vitest';
import { evaluateReplyWindow, replyEventTypeFor } from '@/modules/inbox/reply-window';
import { ConversationKind, ConversationStatus, OutboundEventType } from '@/shared/enums';

/**
 * Meta's 24-hour messaging window, decided before a reply is accepted.
 *
 * Worth testing precisely because the failure is invisible without it: accepting
 * the reply returns 202 and the agent is told it was sent, and only a
 * dead-lettered ledger row hours later says otherwise.
 */
const NOW = new Date('2026-08-23T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

describe('evaluateReplyWindow', () => {
  it('allows a reply inside the window', () => {
    const result = evaluateReplyWindow({
      conversationKind: ConversationKind.DirectMessage,
      lastInboundAt: hoursAgo(23),
      now: NOW,
    });

    expect(result.canReply).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('refuses a reply outside the window, and says how stale it is', () => {
    const result = evaluateReplyWindow({
      conversationKind: ConversationKind.DirectMessage,
      lastInboundAt: hoursAgo(26),
      now: NOW,
    });

    expect(result.canReply).toBe(false);
    expect(result.reason).toContain('26 hours ago');
    // The agent is told what they CAN still do.
    expect(result.reason).toContain('internal note');
  });

  it('allows a reply at exactly the boundary', () => {
    // 24h is inside; only strictly older is refused. Meta rejects beyond the
    // window, so the boundary itself must not be treated as expired.
    const result = evaluateReplyWindow({
      conversationKind: ConversationKind.DirectMessage,
      lastInboundAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      now: NOW,
    });

    expect(result.canReply).toBe(true);
  });

  it('refuses one millisecond past the boundary', () => {
    const result = evaluateReplyWindow({
      conversationKind: ConversationKind.DirectMessage,
      lastInboundAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000 - 1),
      now: NOW,
    });

    expect(result.canReply).toBe(false);
  });

  it('refuses a thread the customer has never written to', () => {
    // A business cannot open a message thread, so there is nothing to reply to.
    const result = evaluateReplyWindow({
      conversationKind: ConversationKind.DirectMessage,
      lastInboundAt: null,
      now: NOW,
    });

    expect(result.canReply).toBe(false);
    expect(result.reason).toContain('has not messaged yet');
  });

  it.each([ConversationKind.CommentThread, ConversationKind.Mention])(
    'applies no window to %s',
    (conversationKind) => {
      // A comment can be answered years later. Applying the messaging window
      // here would block replies the platform accepts perfectly well.
      const result = evaluateReplyWindow({
        conversationKind,
        lastInboundAt: hoursAgo(24 * 365),
        now: NOW,
      });

      expect(result.canReply).toBe(true);
      expect(result.reason).toBeNull();
    },
  );

  it('applies the window to a story reply, because it is delivered as a message', () => {
    // A story reply arrives in the message thread and is answered there, so
    // Meta's messaging window governs it exactly as it governs a DM. Exempting
    // it let the reply box stay enabled on a thread Meta would refuse.
    const result = evaluateReplyWindow({
      conversationKind: ConversationKind.StoryReply,
      lastInboundAt: hoursAgo(25),
      now: NOW,
    });

    expect(result.canReply).toBe(false);
    expect(result.reason).toContain('24 hours');
  });

  it('allows a story reply inside the window', () => {
    const result = evaluateReplyWindow({
      conversationKind: ConversationKind.StoryReply,
      lastInboundAt: hoursAgo(2),
      now: NOW,
    });

    expect(result.canReply).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('refuses a review outright, whatever the timestamps say', () => {
    // There is no Graph surface to answer one with, so "not right now" would be
    // the wrong thing to tell an agent — it is never.
    const result = evaluateReplyWindow({
      conversationKind: ConversationKind.Review,
      lastInboundAt: hoursAgo(1),
      now: NOW,
    });

    expect(result.canReply).toBe(false);
    expect(result.reason).toContain('does not accept replies');
  });

  describe('a conversation that is no longer open', () => {
    it.each([ConversationStatus.Resolved, ConversationStatus.Closed, ConversationStatus.Archived])(
      'refuses a reply on a %s thread',
      (status) => {
        /*
         * Only `archived` was checked on the reply path, so an agent could answer
         * a conversation a colleague had already resolved — which is the thing a
         * status is for. Told to the client here rather than only enforced, so the
         * reply box explains itself instead of answering 409.
         */
        const result = evaluateReplyWindow({
          conversationKind: ConversationKind.CommentThread,
          lastInboundAt: hoursAgo(1),
          status,
          now: NOW,
        });

        expect(result.canReply).toBe(false);
        expect(result.reason).toContain(status);
      },
    );

    it.each([ConversationStatus.Open, ConversationStatus.Pending])(
      'allows a reply on a %s thread',
      (status) => {
        const result = evaluateReplyWindow({
          conversationKind: ConversationKind.CommentThread,
          lastInboundAt: hoursAgo(1),
          status,
          now: NOW,
        });

        expect(result.canReply).toBe(true);
      },
    );

    it('ignores status when the caller does not supply one', () => {
      // The parameter is optional so callers that only care about the platform's
      // own rules are unaffected.
      const result = evaluateReplyWindow({
        conversationKind: ConversationKind.CommentThread,
        lastInboundAt: hoursAgo(1),
        now: NOW,
      });

      expect(result.canReply).toBe(true);
    });
  });

  describe('replyEventTypeFor', () => {
    it.each([
      [ConversationKind.DirectMessage, OutboundEventType.DirectMessage],
      [ConversationKind.StoryReply, OutboundEventType.DirectMessage],
      [ConversationKind.CommentThread, OutboundEventType.CommentReply],
      // The bug this map replaced: a mention was sent as a DIRECT MESSAGE
      // addressed to a comment id, which Meta refuses.
      [ConversationKind.Mention, OutboundEventType.CommentReply],
    ])('routes %s to %s', (kind, expected) => {
      expect(replyEventTypeFor(kind)).toBe(expected);
    });

    it('has no route for a review', () => {
      expect(replyEventTypeFor(ConversationKind.Review)).toBeNull();
    });

    it('covers every conversation kind', () => {
      // The guard against the next kind being added and silently falling into
      // whatever the last branch happened to be.
      for (const kind of Object.values(ConversationKind)) {
        expect(replyEventTypeFor(kind)).not.toBeUndefined();
      }
    });
  });

  it('applies no window to a comment thread with no inbound message either', () => {
    const result = evaluateReplyWindow({
      conversationKind: ConversationKind.CommentThread,
      lastInboundAt: null,
      now: NOW,
    });

    expect(result.canReply).toBe(true);
  });
});
