import { describe, expect, it } from 'vitest';
import { normalizeComment } from '@/modules/inbox/comment-normalizer';
import { Platform } from '@/shared/enums';

/**
 * The two platforms' comment shapes, collapsed to one.
 *
 * These tests exist because of a silent defect: the webhook router mapped
 * Instagram's `comments` field to the comment event type, but the projector read
 * only Facebook's feed shape — so every Instagram comment was skipped as "not a
 * comment" and nothing failed. A skip is invisible, which is exactly why this
 * needs assertions rather than a live check.
 */
describe('normalizeComment', () => {
  describe('facebook', () => {
    const change = (value: Record<string, unknown>) => ({ field: 'feed', value });

    it('reads a comment out of a feed change', () => {
      const result = normalizeComment(
        Platform.Facebook,
        change({
          item: 'comment',
          verb: 'add',
          comment_id: 'CM_1',
          post_id: 'POST_1',
          message: 'hello',
          created_time: 1_700_000_000,
          from: { id: 'FB_USER', name: 'Ada' },
        }),
      );

      expect(result).toEqual({
        comment: {
          commentId: 'CM_1',
          rootCommentId: 'CM_1',
          parentId: null,
          postId: 'POST_1',
          text: 'hello',
          createdAt: new Date(1_700_000_000 * 1000),
          authorPlatformId: 'FB_USER',
          authorName: 'Ada',
        },
      });
    });

    it('threads a reply under its parent rather than opening a thread', () => {
      const result = normalizeComment(
        Platform.Facebook,
        change({
          item: 'comment',
          verb: 'add',
          comment_id: 'CM_2',
          parent_id: 'CM_1',
          from: { id: 'FB_USER' },
        }),
      );

      expect(result).toMatchObject({
        comment: { commentId: 'CM_2', parentId: 'CM_1', rootCommentId: 'CM_1' },
      });
    });

    it('skips a feed change that is not a comment', () => {
      const result = normalizeComment(Platform.Facebook, change({ item: 'like', verb: 'add' }));
      expect(result).toEqual({ skip: 'not a comment (item="like")' });
    });

    it.each(['remove', 'hide'])('skips the "%s" verb', (verb) => {
      const result = normalizeComment(
        Platform.Facebook,
        change({ item: 'comment', verb, comment_id: 'CM_1', from: { id: 'U' } }),
      );
      expect(result).toEqual({ skip: `comment verb "${verb}" is not projected yet` });
    });

    it('skips a comment with no author', () => {
      const result = normalizeComment(
        Platform.Facebook,
        change({ item: 'comment', verb: 'add', comment_id: 'CM_1' }),
      );
      expect(result).toEqual({ skip: 'the comment names no author' });
    });
  });

  describe('instagram', () => {
    const change = (value: Record<string, unknown>) => ({ field: 'comments', value });

    it('reads a comment that carries none of facebook’s field names', () => {
      const result = normalizeComment(
        Platform.Instagram,
        change({
          id: 'IG_CM_1',
          text: 'nice',
          timestamp: '2026-06-21T08:58:00+0000',
          media: { id: 'MEDIA_1' },
          from: { id: 'IG_USER', username: 'ada' },
        }),
      );

      expect(result).toEqual({
        comment: {
          commentId: 'IG_CM_1',
          rootCommentId: 'IG_CM_1',
          parentId: null,
          postId: 'MEDIA_1',
          text: 'nice',
          createdAt: new Date('2026-06-21T08:58:00+0000'),
          authorPlatformId: 'IG_USER',
          authorName: 'ada',
        },
      });
    });

    it('would previously have been skipped as "not a comment"', () => {
      // The regression guard: this payload has no `item` and no `comment_id`, so
      // the old Facebook-only reader rejected it.
      const result = normalizeComment(
        Platform.Instagram,
        change({ id: 'IG_CM_2', text: 'hi', from: { id: 'IG_USER' } }),
      );
      expect('comment' in result).toBe(true);
    });

    it('accepts unix seconds as well as ISO-8601', () => {
      const result = normalizeComment(
        Platform.Instagram,
        change({ id: 'IG_CM_3', timestamp: 1_700_000_000, from: { id: 'U' } }),
      );
      expect(result).toMatchObject({ comment: { createdAt: new Date(1_700_000_000 * 1000) } });
    });

    it('never stores 1970 for an unparseable timestamp', () => {
      const result = normalizeComment(
        Platform.Instagram,
        change({ id: 'IG_CM_4', timestamp: 'not-a-date', from: { id: 'U' } }),
      );
      expect(result).toMatchObject({ comment: { createdAt: null } });
    });

    it('refuses to identify a customer by username alone', () => {
      // A handle can be changed and reused, so it is not an identity. Filing a
      // comment against it would eventually attribute one person's words to
      // another.
      const result = normalizeComment(
        Platform.Instagram,
        change({ id: 'IG_CM_5', text: 'hi', username: 'ada' }),
      );
      expect(result).toEqual({ skip: 'the instagram comment names no author id' });
    });

    it('falls back to the flat username for the display name', () => {
      const result = normalizeComment(
        Platform.Instagram,
        change({ id: 'IG_CM_6', username: 'ada', from: { id: 'IG_USER' } }),
      );
      expect(result).toMatchObject({ comment: { authorName: 'ada' } });
    });

    it('skips a payload with no comment id', () => {
      const result = normalizeComment(Platform.Instagram, change({ text: 'orphan' }));
      expect(result).toEqual({ skip: 'the instagram comment carries no id' });
    });
  });
});
