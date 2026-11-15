/**
 * A bound on how long we will wait for somebody else's server.
 *
 * Every external call needs one, and an SDK's own timeout is not a
 * substitute: a client that retries underneath us multiplies its per-attempt
 * timeout by the number of attempts, so the only honest total is the one the
 * caller states here.
 *
 * THE TIMER IS ALWAYS CLEARED. A `Promise.race` whose loser keeps a live
 * `setTimeout` holds the event loop open, which turns a tidy shutdown into a
 * process that will not exit — the sort of thing that only shows up in a
 * worker that is supposed to drain and stop.
 *
 * The expiry error is the CALLER'S to build, because the one thing a timeout
 * must not do is arrive as a shape the caller does not handle.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  onExpiry: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onExpiry()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
