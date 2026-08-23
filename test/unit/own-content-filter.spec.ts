import { describe, expect, it } from 'vitest';
import { CommentProjectorService } from '@/modules/inbox/comment-projector.service';
import { Platform } from '@/shared/enums';

/**
 * The business's own comments must not become customers.
 *
 * Meta delivers a Page's own comments through the same webhook as a customer's,
 * and nothing filtered them — so every agent reply that echoed back created a
 * CUSTOMER record for the business itself and a conversation attributed to it,
 * inflating customer counts and engagement metrics with the business's own
 * activity. The DM projector already had Meta's `is_echo` flag for exactly this;
 * comments carry no such flag, so the author has to be compared against our own
 * ids.
 *
 * Every dependency is a bare stub on purpose: the filter returns BEFORE any of
 * them is touched, so a stub that would explode on contact is the assertion.
 * If the filter ever stops short-circuiting, these tests fail loudly.
 */
describe('own-content filtering', () => {
  const explode = new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(
          `the projector reached a dependency it should not have: ${String(property)}`,
        );
      },
    },
  ) as never;

  const projector = new CommentProjectorService(
    explode,
    explode,
    explode,
    explode,
    explode,
    explode,
    {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never,
  );

  const OUR_PAGE = 'PAGE_1';
  const OUR_INSTAGRAM = 'IG_1';

  const facebookComment = (authorId: string) => ({
    field: 'feed',
    value: {
      item: 'comment',
      verb: 'add',
      comment_id: 'CM_1',
      post_id: 'POST_1',
      message: 'thanks for getting in touch',
      from: { id: authorId, name: 'Whoever' },
    },
  });

  it('skips a comment authored by our own Page', async () => {
    const outcome = await projector.project(1, 2, Platform.Facebook, 3, facebookComment(OUR_PAGE), [
      OUR_PAGE,
    ]);

    expect(outcome.projected).toBe(false);
    expect(outcome.reason).toContain("business's own");
  });

  it('skips a comment authored by our Instagram account', async () => {
    // An Instagram comment's author is the Instagram account, while sends go
    // through the Page — so either id can appear as the author of our content.
    const outcome = await projector.project(
      1,
      2,
      Platform.Instagram,
      3,
      {
        field: 'comments',
        value: { id: 'IG_CM_1', text: 'hi', from: { id: OUR_INSTAGRAM, username: 'us' } },
      },
      [OUR_INSTAGRAM, OUR_PAGE],
    );

    expect(outcome.projected).toBe(false);
    expect(outcome.reason).toContain("business's own");
  });

  it('skips a mention we made of ourselves', async () => {
    const outcome = await projector.projectMention(
      1,
      2,
      Platform.Facebook,
      3,
      {
        field: 'mention',
        value: { verb: 'add', post_id: 'POST_9', sender_id: OUR_PAGE, message: 'our own post' },
      },
      [OUR_PAGE],
    );

    expect(outcome.projected).toBe(false);
    expect(outcome.reason).toContain("business's own");
  });

  it('does NOT skip a customer whose id merely resembles ours', async () => {
    /*
     * The comparison is exact. A prefix or substring match would drop real
     * customers, which is a worse failure than the one being fixed — a silently
     * missing conversation rather than a spurious one.
     */
    await expect(
      projector.project(1, 2, Platform.Facebook, 3, facebookComment('PAGE_10'), [OUR_PAGE]),
    ).rejects.toThrow(/reached a dependency/u);
  });

  it('does not filter anything when we were told no ids', async () => {
    // The parameter defaults to empty, so an unwired caller behaves exactly as
    // before rather than silently dropping every comment.
    await expect(
      projector.project(1, 2, Platform.Facebook, 3, facebookComment('SOMEONE')),
    ).rejects.toThrow(/reached a dependency/u);
  });
});
