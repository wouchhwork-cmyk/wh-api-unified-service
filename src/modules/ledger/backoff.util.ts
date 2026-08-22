import { RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS } from '@/shared/constants';

/**
 * Exponential backoff with FULL JITTER.
 *
 * The jitter is the point: without it, every item that failed during a platform
 * outage retries at the same instant on recovery, and the stampede causes the
 * next outage. Full jitter spreads them across the whole window.
 */
export function nextAttemptDelayMs(attemptCount: number): number {
  const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptCount - 1), RETRY_MAX_DELAY_MS);
  return Math.floor(exponential * (0.5 + Math.random() / 2));
}

export function nextAttemptAt(attemptCount: number, now = Date.now()): Date {
  return new Date(now + nextAttemptDelayMs(attemptCount));
}

/**
 * Whether another attempt is allowed. Returning null means the row is spent and
 * must become terminal rather than being retried forever — a poison row with no
 * dead-letter state is an infinite loop with a database bill.
 */
export function scheduleRetry(
  attemptCount: number,
  maxAttempts: number,
): { nextAttemptAt: Date } | null {
  if (attemptCount >= maxAttempts) return null;
  return { nextAttemptAt: nextAttemptAt(attemptCount) };
}
