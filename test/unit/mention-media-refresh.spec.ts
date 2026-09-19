import { describe, expect, it } from 'vitest';
import {
  READ_PATH_PLATFORM_BUDGET_MS,
  MENTION_MEDIA_TTL_MS,
  PLATFORM_REQUEST_TIMEOUT_MS,
} from '@/shared/constants';
import { isExpiringMediaUrl } from '@/modules/inbox/attachment-normalizer';

/**
 * A mention's media links expire, so they are re-resolved when a thread is
 * opened and they are old enough to be at risk.
 *
 * THE FAILURE THIS FIXES. Instagram serves media from signed CDN links whose
 * expiry is carried in the link itself, as the `oe=` parameter. A mention is
 * resolved once, when it arrives, and that answer used to be served forever —
 * so a mention opened days later showed a broken image on a post that was
 * perfectly fine, with nothing to explain it. Measured on a real reel: the
 * `media_url` lasted about 35 hours and the thumbnail about 4.5 days.
 *
 * The rules under test are the ones that make this safe rather than merely
 * correct: refresh only when due, and never let it break the read.
 */
describe('mention media refresh', () => {
  const SHORTEST_OBSERVED_LIFETIME_MS = 35 * 60 * 60 * 1000;

  describe('the window', () => {
    it('refreshes well before the shortest link we have seen expires', () => {
      /*
       * The TTL is chosen against the SHORTEST observed lifetime, not an
       * average. A link handed to a browser is at most one TTL old, so this
       * margin is what stops a link expiring while somebody is looking at it.
       */
      expect(MENTION_MEDIA_TTL_MS).toBeLessThan(SHORTEST_OBSERVED_LIFETIME_MS / 2);
    });

    it('is long enough that opening a thread repeatedly costs nothing', () => {
      // Refreshing per request would put a Graph call on every thread open.
      expect(MENTION_MEDIA_TTL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    });
  });

  describe('deciding whether a stored answer is due', () => {
    /** The gate as the service applies it. */
    const isDue = (refreshedAt: string | undefined, now: number): boolean => {
      const parsed = refreshedAt === undefined ? Number.NaN : Date.parse(refreshedAt);
      return !(now - parsed < MENTION_MEDIA_TTL_MS);
    };

    const NOW = Date.parse('2026-09-19T12:00:00Z');

    it('leaves a recently refreshed mention alone', () => {
      expect(isDue('2026-09-19T11:30:00Z', NOW)).toBe(false);
    });

    it('refreshes one that is past the window', () => {
      expect(isDue('2026-09-18T12:00:00Z', NOW)).toBe(true);
    });

    it('refreshes a mention resolved before the stamp existed', () => {
      /*
       * Every conversation stored before this feature has no stamp at all.
       * `Date.parse(undefined)` is NaN and every comparison with NaN is false,
       * so the negation makes it due — which is what we want: refresh once,
       * after which it has a stamp like everything else. Getting this backwards
       * would mean the existing mentions, the ones actually broken today, were
       * the only ones never fixed.
       */
      expect(isDue(undefined, NOW)).toBe(true);
    });

    it('refreshes one whose stamp is not a date', () => {
      // Same NaN path, reached by corrupt metadata rather than absent metadata.
      expect(isDue('not-a-timestamp', NOW)).toBe(true);
    });
  });

  describe('the expiry signal the client needs', () => {
    const REEL_THUMBNAIL =
      'https://scontent-maa3-1.cdninstagram.com/v/t51.71878-15/742011951_153.jpg?oe=6AA79C10';
    const PERMALINK = 'https://www.instagram.com/reel/DapLjo9Bger/';

    it('marks an Instagram CDN link as expiring', () => {
      expect(isExpiringMediaUrl(REEL_THUMBNAIL)).toBe(true);
    });

    it('does not mark the permalink, which is the durable fallback', () => {
      // This is the whole point of exposing the flag: a client that knows the
      // media link can die has somewhere to send the person instead.
      expect(isExpiringMediaUrl(PERMALINK)).toBe(false);
    });

    it('treats a mention with no media as not expiring, rather than unknown', () => {
      expect(isExpiringMediaUrl(null)).toBe(false);
      expect(isExpiringMediaUrl(undefined)).toBe(false);
    });
  });

  describe('the read budget, and what it may be spent on', () => {
    /*
     * MEASURED 19 Sep 2026 against the live API, end to end. These numbers are
     * why the two refreshes are built differently — and why the first attempt
     * did not work at all: a 1.5s budget was applied to a call that takes four
     * seconds, so it timed out every time and silently served the stale answer.
     * Narrowing the query changed nothing; the latency is Meta's mentions edge,
     * not the field list.
     */
    const PROFILE_CALL_MS = 866;
    const MENTION_CALL_MS = 3_158;

    it('is far tighter than the timeout a worker gets', () => {
      // Ten seconds is reasonable for a worker and not for somebody who has
      // just clicked a conversation.
      expect(READ_PATH_PLATFORM_BUDGET_MS).toBeLessThan(PLATFORM_REQUEST_TIMEOUT_MS / 4);
    });

    it('comfortably covers the profile call, which the read does wait for', () => {
      expect(READ_PATH_PLATFORM_BUDGET_MS).toBeGreaterThan(PROFILE_CALL_MS);
    });

    it('does NOT cover the mention call, which is why that one runs behind', () => {
      /*
       * The assertion that would have caught the bug. If this budget is ever
       * raised past the mention latency and that call moved back onto the read
       * path, opening a mention takes four seconds.
       */
      expect(READ_PATH_PLATFORM_BUDGET_MS).toBeLessThan(MENTION_CALL_MS);
    });
  });

  describe('the expiry really is in the link', () => {
    it('reads oe= as the moment the link stops working', () => {
      /*
       * Not decoration: this is how the TTL above was chosen. These are the two
       * links from the mention that prompted the fix, resolved 2026-09-09.
       */
      const expiryOf = (oe: string): Date => new Date(Number.parseInt(oe, 16) * 1000);

      expect(expiryOf('6AA39DCE').toISOString()).toBe('2026-09-11T06:21:02.000Z');
      expect(expiryOf('6AA79C10').toISOString()).toBe('2026-09-14T07:02:40.000Z');

      const resolvedAt = Date.parse('2026-09-09T19:40:08Z');
      const videoLifetime = expiryOf('6AA39DCE').getTime() - resolvedAt;
      expect(videoLifetime).toBeLessThan(SHORTEST_OBSERVED_LIFETIME_MS + 60 * 60 * 1000);
    });
  });
});
