import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';

/**
 * Resolving a mention when the mention is ITSELF a reply.
 *
 * Instagram lets somebody tag us in a reply to a comment, not only in a
 * top-level one — and a reply has no replies of its own. Asking for them fails
 * the WHOLE query with `(#100) Field is only available for top-level comments`,
 * so a resolver that always asked lost the entire mention, author and all, over
 * a field that could never have applied.
 *
 * Observed on live traffic: event 1523 was skipped as "carries no author" while
 * Meta was perfectly willing to describe the comment.
 */
describe('resolveInstagramMention — a mention inside a reply', () => {
  afterEach(() => vi.unstubAllGlobals());

  const config = {
    meta: { appSecret: 'secret', graphVersion: 'v23.0' },
    http: { timeoutMs: 5000 },
  } as never;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const NESTED_ERROR = {
    error: {
      message: '(#100) Field is only available for top-level comments.',
      type: 'OAuthException',
      code: 100,
    },
  };

  it('drops the reply thread and keeps the mention', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      /*
       * The first attempt asks for replies; only the retry omits them. The
       * post's comment section is a separate call and must not be mistaken for
       * either — it asks for `comments`, never `replies`.
       */
      if (href.includes('replies')) return Promise.resolve(json(400, NESTED_ERROR));
      if (href.includes('comments.limit')) return Promise.resolve(json(200, { mentioned_comment: {} }));
      return Promise.resolve(
        json(200, {
          mentioned_comment: {
            id: 'C_NESTED',
            text: '@ai_automation_demo tell this guy',
            username: 'testrestaurant_sd',
            timestamp: '2026-09-07T18:18:24+0000',
            media: { id: 'M_1', permalink: 'https://instagram.com/p/X/', username: 'snots.dale' },
          },
        }),
      );
    });

    const resolved = await new GraphApiClient(config).resolveInstagramMention(
      'IG_1',
      { commentId: 'C_NESTED', mediaId: 'M_1' },
      'token',
    );

    expect(resolved?.authorUsername).toBe('testrestaurant_sd');
    expect(resolved?.text).toBe('@ai_automation_demo tell this guy');
    expect(resolved?.permalink).toBe('https://instagram.com/p/X/');
    // A reply has no thread of its own, and that is not a failure.
    expect(resolved?.replies).toEqual([]);
    /*
     * Counted by INTENT rather than in total, so adding another call elsewhere
     * cannot silently break this: what matters is that the thread was asked for
     * once, refused, and asked again without it.
     */
    expect(calls.filter((href) => href.includes('replies'))).toHaveLength(1);
    expect(calls.filter((href) => !href.includes('replies') && !href.includes('comments.limit'))).toHaveLength(1);
  });

  it('asks only once when the mention IS top-level', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      // The post's comment section is a separate call with its own shape.
      if (href.includes('comments.limit')) return Promise.resolve(json(200, { mentioned_comment: {} }));
      return Promise.resolve(
        json(200, {
          mentioned_comment: {
            id: 'C_TOP',
            text: '@ai_automation_demo wating on you man',
            username: 'genzrelics',
            replies: { data: [{ id: 'R_1', text: 'what happned ?', timestamp: 'T', like_count: 0 }] },
            media: { id: 'M_1', permalink: 'https://instagram.com/p/X/', username: 'snots.dale' },
          },
        }),
      );
    });

    const resolved = await new GraphApiClient(config).resolveInstagramMention(
      'IG_1',
      { commentId: 'C_TOP', mediaId: 'M_1' },
      'token',
    );

    expect(resolved?.replies).toHaveLength(1);
    expect(resolved?.replies[0]?.text).toBe('what happned ?');
    // The thread came back on the first ask, so nothing is retried.
    expect(calls.filter((href) => href.includes('replies'))).toHaveLength(1);
  });

  it('rethrows a real failure rather than reporting no author', async () => {
    /*
     * A token problem must NOT be downgraded into "this mention has no author":
     * that skips the ledger row and nothing ever looks at it again.
     */
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        json(400, { error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } }),
      ),
    );

    await expect(
      new GraphApiClient(config).resolveInstagramMention('IG_1', { commentId: 'C' }, 'token'),
    ).rejects.toThrow(/OAuth/u);
  });
});

/**
 * Putting names back on a mention's thread.
 *
 * Meta returns the comments around a mention with the author omitted on every
 * one — but several of them are OURS: replies this business sent, and earlier
 * mentions already stored with a name against them. Rendering those as
 * "someone" told an agent we did not know who had said something we said
 * ourselves, and the mention appeared twice because it is a sibling of itself.
 */
describe('a mention thread, named from what we already hold', () => {
  const REPLIES = [
    { platformId: 'C_STRANGER', text: 'ooo', timestamp: 'T1', likeCount: 0 },
    { platformId: 'C_OURS_OUT', text: '@genzrelics i am seeing you', timestamp: 'T2', likeCount: 0 },
    { platformId: 'C_OURS_IN', text: '@ai_automation_demo 👏', timestamp: 'T3', likeCount: 0 },
    { platformId: 'C_THIS', text: '@ai_automation_demo so you exist', timestamp: 'T4', likeCount: 0 },
  ];

  /** Mirrors the controller's shaping rule, which is the thing under test. */
  function shape(
    reply: Record<string, unknown>,
    known: Map<string, { authorName: string | null; direction: string }>,
    thisMentionCommentId: string,
  ) {
    const platformId = typeof reply.platformId === 'string' ? reply.platformId : null;
    const match = platformId ? known.get(platformId) : undefined;
    return {
      text: reply.text,
      authorUsername: match?.authorName ?? null,
      isOurs: match?.direction === 'outbound',
      isThisMention: platformId !== null && platformId === thisMentionCommentId,
    };
  }

  const known = new Map([
    ['C_OURS_OUT', { authorName: null, direction: 'outbound' }],
    ['C_OURS_IN', { authorName: 'genzrelics', direction: 'inbound' }],
    ['C_THIS', { authorName: 'genzrelics', direction: 'inbound' }],
  ]);

  it('marks our own sends as ours rather than anonymous', () => {
    const shaped = REPLIES.map((reply) => shape(reply, known, 'C_THIS'));

    expect(shaped[1]).toMatchObject({ isOurs: true, authorUsername: null });
    // A stranger stays honestly unnamed — Meta really does not tell us.
    expect(shaped[0]).toMatchObject({ isOurs: false, authorUsername: null });
  });

  it('names a comment we already hold', () => {
    const shaped = REPLIES.map((reply) => shape(reply, known, 'C_THIS'));
    expect(shaped[2]).toMatchObject({ isOurs: false, authorUsername: 'genzrelics' });
  });

  it('flags the mention that is its own sibling, so it is drawn once', () => {
    const shaped = REPLIES.map((reply) => shape(reply, known, 'C_THIS'));
    expect(shaped.filter((entry) => entry.isThisMention)).toHaveLength(1);
    expect(shaped.find((entry) => entry.isThisMention)?.text).toBe(
      '@ai_automation_demo so you exist',
    );
    // Everything else survives the filter the client applies.
    expect(shaped.filter((entry) => !entry.isThisMention)).toHaveLength(3);
  });
});
