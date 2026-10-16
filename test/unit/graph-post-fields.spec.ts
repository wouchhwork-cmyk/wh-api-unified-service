import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import type { AppConfigService } from '@/config';

/**
 * WHICH FIELDS A POSTS WALK ASKS FOR, and the one it must not.
 *
 * `reactions.summary(total_count)` requires `pages_read_user_content` — the
 * same permission as nested comments, which this client already takes care not
 * to request on a posts-only walk. Reactions were added later for engagement
 * counts and went in unconditionally, so EVERY Facebook posts refresh returned
 * (#10) and paused. That job is also the only thing that renews a post's signed
 * image url, so every Facebook preview on the account expired and stayed
 * expired for a month while the cause looked like an image problem.
 *
 * Verified field by field against the live Page on 26 Sep 2026: core fields,
 * full_picture, attachments, shares and comment_summary all return 200 with an
 * ordinary Page token; reactions.summary and nested comments are the only two
 * that return #10.
 */
const config = {
  meta: {
    appId: 'app',
    appSecret: 'secret',
    graphApiVersion: 'v25.0',
    oauthRedirectUri: 'https://example.test/cb',
  },
} as unknown as AppConfigService;

/** Captures the querystring without any network. */
function clientCapturing(urls: string[]): GraphApiClient {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      urls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return new GraphApiClient(config);
}

describe('the fields a Facebook posts walk requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does NOT ask for reactions on a posts-only walk', async () => {
    const urls: string[] = [];
    await clientCapturing(urls).listPagePosts('123', 'token', { withComments: false });

    expect(urls).toHaveLength(1);
    expect(decodeURIComponent(urls[0] as string)).not.toContain('reactions');
  });

  it('keeps the counts that cost nothing', async () => {
    /*
     * The other half: dropping reactions must not quietly drop the engagement
     * fields that a Page token IS allowed to read, or the fix trades one set of
     * permanently-zero columns for another.
     */
    const urls: string[] = [];
    await clientCapturing(urls).listPagePosts('123', 'token', { withComments: false });
    const query = decodeURIComponent(urls[0] as string);

    expect(query).toContain('comment_summary');
    expect(query).toContain('shares');
    expect(query).toContain('full_picture');
  });

  it('asks for reactions only alongside comments', async () => {
    // The caller requesting comments is the one that believes it holds
    // pages_read_user_content, so that is where the other field that needs it
    // belongs.
    const urls: string[] = [];
    await clientCapturing(urls).listPagePosts('123', 'token', { withComments: true });
    const query = decodeURIComponent(urls[0] as string);

    expect(query).toContain('reactions.summary');
    expect(query).toContain('comments.limit');
  });
});
