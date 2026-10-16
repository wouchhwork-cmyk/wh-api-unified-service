import { describe, expect, it } from 'vitest';
import {
  nextAttemptAt,
  nextAttemptDelayMs,
  parkFor,
  scheduleRetry,
} from '@/modules/ledger/backoff.util';
import {
  OUTBOUND_RATE_LIMIT_PARK_MS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from '@/shared/constants';

/**
 * The retry schedule, which is the difference between a queue that recovers and
 * one that dead-letters work the platform would have accepted.
 *
 * Jitter makes exact assertions impossible on purpose, so these bound the range
 * rather than pin a value.
 */
describe('backoff', () => {
  it('grows exponentially and stays within the jitter window', () => {
    for (const attempt of [1, 2, 3, 4]) {
      const delay = nextAttemptDelayMs(attempt);
      const ceiling = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(ceiling * 0.5));
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it('never exceeds the ceiling, however many attempts have passed', () => {
    expect(nextAttemptDelayMs(50)).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
  });

  it('treats attempt zero as the first attempt rather than halving the base', () => {
    expect(nextAttemptDelayMs(0)).toBeLessThanOrEqual(RETRY_BASE_DELAY_MS);
    expect(nextAttemptDelayMs(0)).toBeGreaterThanOrEqual(RETRY_BASE_DELAY_MS / 2);
  });

  it('schedules while the budget holds and stops when it is spent', () => {
    expect(scheduleRetry(1, 3)).not.toBeNull();
    expect(scheduleRetry(2, 3)).not.toBeNull();
    // Spent, not "one more": a poison row with no terminal state is an
    // infinite loop with a database bill.
    expect(scheduleRetry(3, 3)).toBeNull();
    expect(scheduleRetry(4, 3)).toBeNull();
  });

  it('offsets from the clock it is given', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(nextAttemptAt(1, now).getTime()).toBeGreaterThanOrEqual(now);
    expect(nextAttemptAt(1, now).getTime()).toBeLessThanOrEqual(now + RETRY_BASE_DELAY_MS);
  });

  describe('parkFor', () => {
    it('waits minutes rather than the exponential curve seconds', () => {
      // The reason it exists: a rate limit lasts minutes, and the exponential
      // schedule spends a whole three-attempt budget in about three seconds.
      const now = Date.parse('2026-01-01T00:00:00.000Z');
      const parked = parkFor(OUTBOUND_RATE_LIMIT_PARK_MS, now).getTime() - now;

      expect(parked).toBeGreaterThan(nextAttemptDelayMs(3));
      expect(parked).toBeGreaterThanOrEqual(OUTBOUND_RATE_LIMIT_PARK_MS / 2);
      expect(parked).toBeLessThanOrEqual(OUTBOUND_RATE_LIMIT_PARK_MS);
    });

    it('keeps the jitter, so a throttled fleet does not resume in lockstep', () => {
      const now = Date.parse('2026-01-01T00:00:00.000Z');
      const samples = new Set(
        Array.from({ length: 40 }, () => parkFor(OUTBOUND_RATE_LIMIT_PARK_MS, now).getTime()),
      );
      expect(samples.size).toBeGreaterThan(1);
    });
  });
});
