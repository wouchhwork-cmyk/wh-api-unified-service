import { describe, expect, it } from 'vitest';
import {
  isExpiredMediaUrl,
  isExpiringMediaUrl,
  mediaUrlExpiresAt,
} from '@/modules/inbox/attachment-normalizer';

/**
 * Reading a signed Meta CDN link's own expiry.
 *
 * THE URL IS REAL — a Facebook post's `full_picture`, synced 29 Aug 2026 and
 * served unchanged until 26 Sep, four weeks after it stopped resolving. Its
 * `oe` says exactly when that happened, which is the whole point: the answer
 * was in the string all along and nothing was reading it.
 */
const REAL = {
  url:
    'https://scontent-maa5-2.xx.fbcdn.net/v/t39.30808-6/728893432_122184327734838220_n.jpg' +
    '?stp=dst-jpg_p720x720_tt6&_nc_cat=109&ccb=1-7&oh=00_AQIgD3ccQVKRABtCmsXqnhClUEKgSscH&oe=6A97D4ED',
  /** 0x6A97D4ED — 2 Sep 2026, 07:49:01 UTC. */
  expiresAt: new Date('2026-09-02T07:49:01.000Z'),
};

describe('when a signed media link stops working', () => {
  it('reads the expiry out of the url', () => {
    expect(mediaUrlExpiresAt(REAL.url)).toEqual(REAL.expiresAt);
  });

  it('calls it expired the moment it is due, not a second later', () => {
    // `oe` is the last instant it works; at exactly that time it is spent.
    expect(isExpiredMediaUrl(REAL.url, REAL.expiresAt)).toBe(true);
    expect(isExpiredMediaUrl(REAL.url, new Date(REAL.expiresAt.getTime() - 1))).toBe(false);
  });

  it('is what "expiring" was never able to answer', () => {
    /*
     * The distinction that made this worth writing. The existing check says the
     * link WILL expire, which is true of this url on the day it was minted and
     * true four weeks later. Only one of those is a reason to stop showing an
     * image and send somebody to the permalink instead.
     */
    const fresh = new Date(REAL.expiresAt.getTime() - 86_400_000);

    expect(isExpiringMediaUrl(REAL.url)).toBe(true);
    expect(isExpiredMediaUrl(REAL.url, fresh)).toBe(false);
  });

  describe('links with no readable expiry', () => {
    it('says nothing about a url with no oe', () => {
      // Not "expired" — unknown. A permalink has no signature and never dies on
      // a schedule, and reporting it as expired would hide a working link.
      expect(mediaUrlExpiresAt('https://www.instagram.com/p/ABC123/')).toBeNull();
      expect(isExpiredMediaUrl('https://www.instagram.com/p/ABC123/')).toBe(false);
    });

    it('refuses an oe that is not hex rather than inventing 1970', () => {
      /*
       * THE BUG THIS PREVENTS. parseInt('12zz', 16) is 18 — a timestamp in
       * January 1970 — so a lenient parse would report every url carrying a
       * junk oe as long expired and blank out perfectly good images.
       */
      expect(mediaUrlExpiresAt('https://scontent.xx.fbcdn.net/x.jpg?oe=12zz')).toBeNull();
      expect(mediaUrlExpiresAt('https://scontent.xx.fbcdn.net/x.jpg?oe=')).toBeNull();
      expect(mediaUrlExpiresAt('https://scontent.xx.fbcdn.net/x.jpg?oe=0')).toBeNull();
    });

    it('survives something that is not a url at all', () => {
      // This runs on every post in every feed; a throw here would take the page
      // down over a malformed row.
      expect(mediaUrlExpiresAt('not a url')).toBeNull();
      expect(mediaUrlExpiresAt(null)).toBeNull();
      expect(mediaUrlExpiresAt(undefined)).toBeNull();
      expect(isExpiredMediaUrl(null)).toBe(false);
    });
  });
});
