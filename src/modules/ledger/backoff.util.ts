import { RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS } from '@/shared/constants';

/**
 * Exponential backoff with FULL JITTER.
 *
 * The jitter is the point: without it, every item that failed during a platform
 * outage retries at the same instant on recovery, and the stampede causes the
 * next outage. Full jitter spreads them across the whole window.
 */
export function nextAttemptDelayMs(attemptCount: number): number {
  const exponential = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptCount - 1),
    RETRY_MAX_DELAY_MS,
  );
  return Math.floor(exponential * (0.5 + Math.random() / 2));
}

export function nextAttemptAt(attemptCount: number, now = Date.now()): Date {
  return new Date(now + nextAttemptDelayMs(attemptCount));
}

/**
 * A FIXED wait with full jitter, for a failure whose duration is known to be
 * long — a rate limit, not a blip.
 *
 * Separate from the exponential curve on purpose: raising that curve's base to
 * suit a rate limit would also delay every transient retry, and lowering the
 * park to suit a blip would spend the attempt budget while the limit still
 * holds. The jitter is kept for the same reason it exists there — so a fleet
 * that was throttled together does not resume together.
 */
export function parkFor(baseMs: number, now = Date.now()): Date {
  return new Date(now + Math.floor(baseMs * (0.5 + Math.random() / 2)));
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
