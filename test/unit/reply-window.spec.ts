import { describe, expect, it } from 'vitest';
import { evaluateReplyWindow, replyEventTypeFor } from '@/modules/inbox/reply-window';
import {
  MentionKind,
  ConversationKind,
  ConversationStatus,
  OutboundEventType,
} from '@/shared/enums';

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

  /*
   * STORY REPLIES USED TO HAVE THEIR OWN CASES HERE, against a
   * ConversationKind.StoryReply that nothing ever assigned. A story reply lands
   * in the DM thread with that person — the thread-key prefix said so by
   * mapping it to 'dm' — so it is governed by the DirectMessage cases above and
   * below, which is why those two tests are gone rather than rewritten. What is
   * really a story reply is the MESSAGE, and `MessageKind.StoryReply` carries
   * that (docs/platform-limitations.md §8.2).
   */

  it('allows a direct message inside the window', () => {
    const result = evaluateReplyWindow({
      conversationKind: ConversationKind.DirectMessage,
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

  /*
   * HOW WE WERE TAGGED decides whether a mention can be answered at all, and
   * this was documented for a fortnight before anything enforced it.
   *
   * Measured against live posts (platform-limitations 1.7b): a caption tag
   * takes a top-level comment with a 200, a comment mention takes a reply
   * beneath that comment, and a collaborator or photo tag refuses both with
   * `#200 Permissions error` — same token, seconds apart.
   */
  describe('a mention, by how it was made', () => {
    const mention = (mentionKind?: string) =>
      evaluateReplyWindow({
        conversationKind: ConversationKind.Mention,
        lastInboundAt: null,
        ...(mentionKind === undefined ? {} : { mentionKind }),
      });

    it('refuses a post we were only TAGGED in', () => {
      const window = mention(MentionKind.Tagged);

      expect(window.canReply).toBe(false);
      // The reason has to name the distinction, because an agent looking at two
      // mentions cannot otherwise tell why one takes a reply and one does not.
      expect(window.reason).toContain('tagged in');
      expect(window.reason).toContain('internal note');
    });

    it('allows a caption mention — the one that CAN be commented on', () => {
      expect(mention(MentionKind.Caption).canReply).toBe(true);
    });

    it('allows a comment mention, answerable beneath the comment', () => {
      expect(mention(MentionKind.Comment).canReply).toBe(true);
    });

    /*
     * Everything mentioned before mention_kind was recorded has no kind at all.
     * Those stay repliable: refusing them would silently close replies on real
     * mentions, and the send path still refuses a tagged post if it is wrong.
     */
    it('allows a mention whose kind was never recorded', () => {
      expect(mention(undefined).canReply).toBe(true);
    });
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
      [ConversationKind.CommentThread, OutboundEventType.CommentReply],
      /*
       * A MENTION IS NOT A COMMENT REPLY, though it looks like one.
       *
       * It was routed as one, and that was still wrong: a mention lives on
       * SOMEBODY ELSE'S post, and `POST /{comment-id}/replies` only works on
       * media we own — it fails there with an error that reads like a deleted
       * comment. Meta's mentions edge is the only way to answer one.
       *
       * (The bug before that was worse: a mention was sent as a DIRECT MESSAGE
       * addressed to a comment id.)
       */
      [ConversationKind.Mention, OutboundEventType.MentionReply],
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
