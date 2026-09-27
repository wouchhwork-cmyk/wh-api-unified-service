import { describe, expect, it } from 'vitest';
import { threadCommentIds } from '@/modules/inbox/inbox.service';

/**
 * Which comments on a mention's post we ask the database to put names to.
 *
 * A mention thread carries THREE lists of comments and they come from
 * different places:
 *
 *   mentionParent.replies  the thread our mention was a reply within
 *   replyThread            the replies directly UNDER our mention
 *   postComments           the wider comment section on the post
 *
 * Anything missed here renders as "someone" — Meta gives no author on a
 * mention, so a name can only come from a comment we already hold.
 *
 * The real function is called rather than a copy of its shaping. An earlier
 * test re-implemented the logic, which is why it kept passing while the
 * function itself was dropping a whole list.
 */
describe('collecting the comment ids in a mention thread', () => {
  const comment = (id: string) => ({ platformId: id, text: 'x' });

  it('collects all three lists', () => {
    expect(
      threadCommentIds({
        mentionParent: { replies: [comment('PARENT_1')] },
        replyThread: [comment('OURS_1')],
        postComments: [comment('POST_1')],
      }).sort(),
    ).toEqual(['OURS_1', 'PARENT_1', 'POST_1']);
  });

  it('collects the replies under OUR mention', () => {
    /*
     * THE ONE THAT WAS MISSING, and the one that hurts most: this is where the
     * business's own answer sits, so an agent's reply came back attributed to
     * a stranger. It is also the only list whose authors we can always name.
     */
    expect(threadCommentIds({ replyThread: [comment('OURS_1'), comment('OURS_2')] })).toEqual([
      'OURS_1',
      'OURS_2',
    ]);
  });

  it('survives a thread with none of them', () => {
    // A caption mention has no parent and no replies yet. Not an error.
    expect(threadCommentIds({})).toEqual([]);
  });

  it('ignores lists that are not lists', () => {
    // These come out of a jsonb column, so the shape is whatever was written —
    // a throw here would take down a thread read.
    expect(
      threadCommentIds({
        mentionParent: 'not an object',
        replyThread: { nope: true },
        postComments: null,
      }),
    ).toEqual([]);
  });

  it('drops entries carrying no platform id', () => {
    expect(
      threadCommentIds({ replyThread: [comment('KEEP'), { text: 'no id' }, null] }),
    ).toEqual(['KEEP']);
  });
});
