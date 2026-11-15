import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDeadline } from '@/shared/utils/deadline';

/**
 * The bound every external call is wrapped in.
 *
 * Worth its own file because the failure it prevents is invisible: a timer
 * left running after the work resolved keeps the event loop alive, so a
 * worker that should drain and exit instead hangs — and nothing about that
 * looks like a bug in the call that caused it.
 */
describe('withDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the work when it finishes in time', async () => {
    await expect(
      withDeadline(Promise.resolve('done'), 1_000, () => new Error('late')),
    ).resolves.toBe('done');
  });

  it('rejects with the caller’s error once the deadline passes', async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const settled = withDeadline(never, 5_000, () => new Error('took too long'));
    const assertion = expect(settled).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('passes a rejection through untouched rather than reporting a timeout', async () => {
    const failure = new Error('the server said no');
    await expect(
      withDeadline(Promise.reject(failure), 1_000, () => new Error('late')),
    ).rejects.toBe(failure);
  });

  it('clears its timer when the work wins, leaving nothing holding the loop open', async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    await withDeadline(Promise.resolve(1), 10_000, () => new Error('late'));
    expect(clear).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
