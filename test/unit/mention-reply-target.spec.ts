import { describe, expect, it } from 'vitest';
import { mentionCommentId, requireMentionMediaId } from '@/modules/inbox/inbox.service';
import { AppException, ErrorCode } from '@/shared/errors';
import { MentionReplyKind, mentionReplyTarget } from '@/modules/connections/graph/graph.types';

/**
 * Where a reply to a mention is actually sent.
 *
 * Meta's mentions edge takes a media id and, OPTIONALLY, a comment id, and the
 * difference decides what the reply becomes:
 *
 *   media_id + comment_id   a reply beneath the comment that named us
 *   media_id alone          a top-level comment on the tagged post
 *
 * Both are correct; sending the wrong one is not. The comment id used to be
 * derived from the thread key, which for a COMMENT mention is the comment and
 * happened to work — and for a CAPTION mention is `mention:<mediaId>`, so the
 * media id went to Meta as a comment id and the reply dead-lettered after the
 * agent had been told 202.
 */
describe('addressing a reply to a mention', () => {
  describe('the post it lives on', () => {
    it('is read from the conversation', () => {
      expect(requireMentionMediaId({ mentionedMediaId: '17911065744521471' })).toBe(
        '17911065744521471',
      );
    });

    it('REFUSES rather than passing nothing to the relay', () => {
      /*
       * A mention projected before the Mentions API was wired in has no post
       * recorded. The null used to be handed onward: the relay accepted the
       * reply, answered 202, and dead-lettered it a moment later with nobody
       * watching. A refusal the agent can read as they press send is the point.
       */
      let thrown: unknown;
      try {
        requireMentionMediaId({});
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppException);
      expect((thrown as AppException).code).toBe(ErrorCode.ReplyNotSupported);
    });

    it('treats an empty string as missing', () => {
      expect(() => requireMentionMediaId({ mentionedMediaId: '' })).toThrow(AppException);
    });
  });

  describe('the comment that named us', () => {
    it('is used when the tag was inside a comment', () => {
      expect(mentionCommentId({ mentionedCommentId: '17949640701295733' })).toBe(
        '17949640701295733',
      );
    });

    it('is NULL for a caption mention, and that null is the instruction', () => {
      /*
       * THE BUG THIS FILE EXISTS FOR. There is no comment anywhere in a caption
       * mention, and null is what makes `replyToMention` omit `comment_id` —
       * which is the shape that posts a top-level comment on the post
       * (platform-limitations 1.7b). Sending the media id here instead
       * addressed a comment that does not exist.
       */
      expect(mentionCommentId({ mentionedMediaId: '17911065744521471' })).toBeNull();
    });

    it('treats an empty string as absent, not as a comment called ""', () => {
      expect(mentionCommentId({ mentionedCommentId: '' })).toBeNull();
    });

    it('ignores a value that is not a string', () => {
      // This comes out of a jsonb column, so the shape is whatever was written.
      expect(mentionCommentId({ mentionedCommentId: 12345 })).toBeNull();
    });
  });
});

/**
 * WHICH OF THE TWO ACTS a mention reply performs, named rather than implied.
 *
 * The client used to take `commentId?: string | null` and decide by
 * truthiness, so the two outcomes were a presence check in an argument list.
 * They are not variations of one thing: one is a reply nested under the
 * comment that named us, the other is a NEW TOP-LEVEL COMMENT on a stranger's
 * post, in the business's name, visible to everyone who looks at it.
 *
 * The consequence of conflating them was one-directional and silent. A lost
 * comment id — a renamed metadata key, a mention projected before the Mentions
 * API was wired in — turned the private act into the public one, and nothing
 * in the type, the call or the logs said so.
 */
describe('which act a mention reply is', () => {
  it('nests under the comment when there is one', () => {
    const target = mentionReplyTarget({ mediaId: 'MEDIA_1', commentId: 'COMMENT_1' });

    expect(target.kind).toBe(MentionReplyKind.ReplyUnderComment);
    expect(target).toEqual({
      kind: MentionReplyKind.ReplyUnderComment,
      mediaId: 'MEDIA_1',
      commentId: 'COMMENT_1',
    });
  });

  /**
   * The only correct use of the public act: a caption mention has no comment
   * to nest under, so a top-level comment is the ONLY way to answer it.
   */
  it('comments on the post for a caption mention, which has no comment', () => {
    const target = mentionReplyTarget({ mediaId: 'MEDIA_1', commentId: null });

    expect(target.kind).toBe(MentionReplyKind.TopLevelComment);
    expect(target).toEqual({ kind: MentionReplyKind.TopLevelComment, mediaId: 'MEDIA_1' });
    /* No comment id is CARRIED, not merely unsent — there is nothing to send. */
    expect(target).not.toHaveProperty('commentId');
  });

  /** Absent and null reach the same act: neither names a comment. */
  it('treats an absent comment id the same as an explicit null', () => {
    expect(mentionReplyTarget({ mediaId: 'MEDIA_1' })).toEqual(
      mentionReplyTarget({ mediaId: 'MEDIA_1', commentId: null }),
    );
    expect(mentionReplyTarget({ mediaId: 'MEDIA_1', commentId: undefined }).kind).toBe(
      MentionReplyKind.TopLevelComment,
    );
  });

  /**
   * An empty string is not a comment id.
   *
   * It would have passed a `!= null` check and been sent to Meta as
   * `comment_id=`, which fails as a malformed object rather than as the
   * caption mention it actually is.
   */
  it('does not treat an empty comment id as a comment', () => {
    expect(mentionReplyTarget({ mediaId: 'MEDIA_1', commentId: '' }).kind).toBe(
      MentionReplyKind.TopLevelComment,
    );
  });

  /**
   * THE TYPE IS THE GUARANTEE, and this is what it buys that a test cannot.
   *
   * `MentionReplyTarget` has no member carrying a nullable comment id, so the
   * nested form cannot be constructed without the comment it nests under —
   * the old ambiguous call is not merely wrong now, it does not compile. The
   * runtime assertions above cover what the type cannot: which branch a given
   * mention takes.
   */
  it('cannot express a nested reply with no comment to nest under', () => {
    const nested = mentionReplyTarget({ mediaId: 'MEDIA_1', commentId: 'COMMENT_1' });
    if (nested.kind !== MentionReplyKind.ReplyUnderComment) throw new Error('unreachable');
    expect(typeof nested.commentId).toBe('string');
    expect(nested.commentId.length).toBeGreaterThan(0);
  });
});
