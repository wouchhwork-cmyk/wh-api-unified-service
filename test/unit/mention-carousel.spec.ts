import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import type { AppConfigService } from '@/config';

/**
 * A mention on a CAROUSEL post keeps every slide.
 *
 * `media_url` on a CAROUSEL_ALBUM is the cover and nothing else, so a mention
 * on a ten-image carousel was stored as one picture and the other nine were
 * never asked for. They were never missing from Meta: verified 26 Sep 2026
 * against a live mention, `children.data` came back with an id, a type and a
 * url per slide the moment the field was named.
 *
 * The shapes below are that response, trimmed.
 */
const config = {
  meta: {
    appId: 'app',
    appSecret: 'secret',
    graphApiVersion: 'v25.0',
    oauthRedirectUri: 'https://example.test/cb',
  },
} as unknown as AppConfigService;

const CAROUSEL = {
  mentioned_comment: {
    id: '18126848260879241',
    text: '@ai_automation_demo post with multiple media ..',
    username: 'genzrelics',
    media: {
      id: '18067668923767437',
      media_type: 'CAROUSEL_ALBUM',
      media_url: 'https://scontent.cdninstagram.com/cover.jpg?oe=6ABDFD3B',
      permalink: 'https://www.instagram.com/p/ABC/',
      username: 'genzrelics',
      children: {
        data: [
          { id: '17907924105305122', media_type: 'IMAGE', media_url: 'https://cdn.test/1.jpg' },
          { id: '18057048566625942', media_type: 'IMAGE', media_url: 'https://cdn.test/2.jpg' },
          // A video slide carries a thumbnail and no media_url, exactly as a
          // reel does at the top level.
          { id: '18057048566625943', media_type: 'VIDEO', thumbnail_url: 'https://cdn.test/3.jpg' },
          // Nothing usable at all: dropped rather than stored as a blank slide.
          { id: '18057048566625944', media_type: 'IMAGE' },
        ],
      },
    },
  },
};

function clientReturning(body: unknown, urls: string[] = []): GraphApiClient {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      urls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return new GraphApiClient(config);
}

describe('a mention on a carousel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks Meta for the slides', async () => {
    const urls: string[] = [];
    await clientReturning(CAROUSEL, urls).resolveInstagramMention(
      '17841472020051826',
      { commentId: '18126848260879241', mediaId: '18067668923767437' },
      'token',
    );

    expect(decodeURIComponent(urls[0] as string)).toContain('children{');
  });

  it('keeps every slide that has something to show', async () => {
    const resolved = await clientReturning(CAROUSEL).resolveInstagramMention(
      '17841472020051826',
      { commentId: '18126848260879241', mediaId: '18067668923767437' },
      'token',
    );

    // Three of the four: the one carrying neither url is not a slide anybody
    // could render, and a blank tile is worse than an absent one.
    expect(resolved?.media?.children).toHaveLength(3);
    expect(resolved?.media?.children?.[0]?.mediaUrl).toBe('https://cdn.test/1.jpg');
    expect(resolved?.media?.children?.[2]).toMatchObject({
      mediaType: 'VIDEO',
      mediaUrl: null,
      thumbnailUrl: 'https://cdn.test/3.jpg',
    });
  });

  it('leaves an ordinary post with an empty list, never null', async () => {
    /*
     * So a client renders slides with a loop and never branches. The cover is
     * in `mediaUrl` either way, which is why a reader that ignores children is
     * still correct rather than merely lucky.
     */
    const single = {
      mentioned_comment: {
        ...CAROUSEL.mentioned_comment,
        media: { ...CAROUSEL.mentioned_comment.media, media_type: 'IMAGE', children: undefined },
      },
    };

    const resolved = await clientReturning(single).resolveInstagramMention(
      '17841472020051826',
      { commentId: '18126848260879241', mediaId: '18067668923767437' },
      'token',
    );

    expect(resolved?.media?.children).toEqual([]);
    expect(resolved?.media?.mediaUrl).toContain('cover.jpg');
  });
});
