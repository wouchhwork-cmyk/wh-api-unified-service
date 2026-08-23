import { describe, expect, it } from 'vitest';
import { normalizeComment, normalizeMention } from '@/modules/inbox/comment-normalizer';
import { IdentifierKind, Platform } from '@/shared/enums';

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
          // Facebook exposes no handle on a comment.
          authorHandle: null,
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

    it('does NOT treat the post as a parent comment', () => {
      /*
       * Facebook sends parent_id = post_id on a TOP-LEVEL comment. Taken at face
       * value, every top-level comment on one post collapsed into a single
       * conversation keyed `comment:<postId>` with the first commenter as its
       * customer — and a reply was POSTed to `<postId>/comments`, which
       * Facebook accepts as a new standalone comment on the post rather than a
       * reply to anybody.
       */
      const result = normalizeComment(
        Platform.Facebook,
        change({
          item: 'comment',
          verb: 'add',
          comment_id: 'CM_1',
          parent_id: 'POST_1',
          post_id: 'POST_1',
          from: { id: 'FB_USER' },
        }),
      );

      expect(result).toMatchObject({
        comment: { commentId: 'CM_1', parentId: null, rootCommentId: 'CM_1' },
      });
    });

    it('gives two top-level comments on one post two different threads', () => {
      const first = normalizeComment(
        Platform.Facebook,
        change({
          item: 'comment',
          verb: 'add',
          comment_id: 'CM_1',
          parent_id: 'POST_1',
          post_id: 'POST_1',
          from: { id: 'ADA' },
        }),
      );
      const second = normalizeComment(
        Platform.Facebook,
        change({
          item: 'comment',
          verb: 'add',
          comment_id: 'CM_2',
          parent_id: 'POST_1',
          post_id: 'POST_1',
          from: { id: 'GRACE' },
        }),
      );

      // The thread key is derived from rootCommentId, so these two must differ
      // or the two people share one conversation and one customer record.
      expect(first).toMatchObject({ comment: { rootCommentId: 'CM_1' } });
      expect(second).toMatchObject({ comment: { rootCommentId: 'CM_2' } });
    });

    it('still threads a reply when post_id is absent', () => {
      // Nothing to compare parent_id against, so it is taken as given — the
      // behaviour before the post-id check, and no worse.
      const result = normalizeComment(
        Platform.Facebook,
        change({
          item: 'comment',
          verb: 'add',
          comment_id: 'CM_3',
          parent_id: 'CM_1',
          from: { id: 'FB_USER' },
        }),
      );

      expect(result).toMatchObject({ comment: { rootCommentId: 'CM_1', parentId: 'CM_1' } });
    });

    it('skips a feed change that is not a comment', () => {
      const result = normalizeComment(Platform.Facebook, change({ item: 'like', verb: 'add' }));
      expect(result).toEqual({ skip: 'not a comment (item="like")' });
    });

    it.each([
      ['remove', 'removed'],
      ['hide', 'hidden'],
      ['unhide', 'unhidden'],
      ['edited', 'edited'],
    ])('reads the "%s" verb as a change to a comment we hold', (verb, action) => {
      /*
       * These were SKIPPED, and the ledger row for each was thrown away — so a
       * comment the customer deleted went on sitting in the inbox, and hiding one
       * changed nothing. The verb is part of the dedup key, so the events had
       * always been arriving distinctly; nothing was ever done with them.
       */
      const result = normalizeComment(
        Platform.Facebook,
        change({ item: 'comment', verb, comment_id: 'CM_1', from: { id: 'U' } }),
      );
      expect(result).toEqual({ moderation: { commentId: 'CM_1', action, text: null } });
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
          // Instagram does, and it is stored as an identifier of its own.
          authorHandle: 'ada',
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

  describe('mentions', () => {
    it('projects an instagram tag, keyed on the handle it is given', () => {
      /*
       * Instagram mentions used to be a dead end: the webhook carries a media or
       * comment id and NO author, so every one was skipped and a business's
       * mention feed was permanently empty. The /tags backfill supplies the
       * tagger's username, which is the only identity that edge offers — so it
       * is recorded AS a handle rather than passed off as an app-scoped id,
       * because a later comment from the same person will carry a real IGSID.
       */
      const result = normalizeMention(Platform.Instagram, {
        field: 'mentions',
        value: {
          media_id: 'IG_MEDIA_9',
          username: 'ada',
          caption: 'look at this',
          permalink: 'https://instagram.test/p/9',
          timestamp: '2026-05-01T10:00:00+0000',
        },
      });

      expect(result).toMatchObject({
        comment: {
          commentId: 'IG_MEDIA_9',
          rootCommentId: 'IG_MEDIA_9',
          parentId: null,
          postId: 'IG_MEDIA_9',
          text: 'look at this',
          authorPlatformId: 'ada',
          authorHandle: 'ada',
          authorIdentifierKind: IdentifierKind.InstagramUsername,
        },
      });
    });

    it('still skips a live instagram mention webhook, and says why', () => {
      // Nothing has changed here: the webhook gives no author, and inventing one
      // would file somebody else's post against the wrong person.
      const result = normalizeMention(Platform.Instagram, {
        field: 'mentions',
        value: { media_id: 'IG_MEDIA_1' },
      });

      expect(result).toMatchObject({ skip: expect.stringContaining('carries no author') });
    });

    it('skips an instagram mention that names nothing at all', () => {
      expect(normalizeMention(Platform.Instagram, { field: 'mentions', value: {} })).toEqual({
        skip: 'the instagram mention names nothing',
      });
    });

    it('reads a facebook mention, which carries its own author', () => {
      const result = normalizeMention(Platform.Facebook, {
        field: 'mention',
        value: {
          verb: 'add',
          post_id: 'POST_7',
          sender_id: 'FB_USER',
          sender_name: 'Grace',
          message: 'nice work',
          created_time: 1_700_000_000,
        },
      });

      expect(result).toMatchObject({
        comment: {
          commentId: 'POST_7',
          authorPlatformId: 'FB_USER',
          authorName: 'Grace',
          // Facebook exposes no handle, and the projector derives the id kind.
          authorHandle: null,
        },
      });
    });
  });
});
