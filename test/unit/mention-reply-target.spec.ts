import { describe, expect, it } from 'vitest';
import { mentionCommentId, requireMentionMediaId } from '@/modules/inbox/inbox.service';
import { AppException, ErrorCode } from '@/shared/errors';

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
