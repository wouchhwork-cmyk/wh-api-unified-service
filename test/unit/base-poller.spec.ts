import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PinoLogger } from 'nestjs-pino';
import type { AppConfigService } from '@/config';
import { BasePoller } from '@/workers/base-poller';

/**
 * The poll loop's scheduling, which is pure timer logic and therefore worth
 * testing without a database.
 *
 * The wake path is the part that can go wrong quietly: a lost wake costs only
 * latency, so a bug here would never fail anything — it would just make the
 * inbox feel slow, which is exactly the kind of defect that survives.
 */
class TestPoller extends BasePoller {
  protected readonly name = 'test';
  public polls = 0;
  public handledPerPoll = 0;

  constructor(
    protected readonly config: AppConfigService,
    protected readonly logger: PinoLogger,
  ) {
    super();
  }

  protected async pollOnce(): Promise<number> {
    this.polls += 1;
    return this.handledPerPoll;
  }
}

const WORKER_CONFIG = {
  pollIntervalMs: 2_000,
  idlePollIntervalMs: 10_000,
  batchSize: 20,
  leaseSeconds: 120,
};

describe('BasePoller scheduling', () => {
  let poller: TestPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    const config = { worker: WORKER_CONFIG } as unknown as AppConfigService;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as PinoLogger;
    poller = new TestPoller(config, logger);
  });

  afterEach(async () => {
    await poller.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('polls once on start', async () => {
    poller.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.polls).toBe(1);
  });

  it('waits the idle interval when a poll finds nothing', async () => {
    poller.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(WORKER_CONFIG.idlePollIntervalMs - 1);
    expect(poller.polls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(poller.polls).toBe(2);
  });

  it('polls again immediately after a full batch', async () => {
    poller.handledPerPoll = WORKER_CONFIG.batchSize;
    poller.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    // No waiting: a full batch means more is probably queued behind it, so the
    // next poll is scheduled at 0ms rather than at the poll interval.
    await vi.advanceTimersByTimeAsync(5);
    expect(poller.polls).toBeGreaterThan(1);
  });

  it('wake() polls without waiting out the idle interval', async () => {
    poller.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.polls).toBe(1);

    poller.wake();
    await vi.advanceTimersByTimeAsync(60);

    // Woken in tens of milliseconds rather than ten seconds.
    expect(poller.polls).toBe(2);
  });

  it('coalesces a burst of wakes into one poll', async () => {
    poller.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 10; i += 1) poller.wake();
    await vi.advanceTimersByTimeAsync(60);

    // Ten inserts, one poll — the debounce that keeps a busy Page from turning
    // every comment into its own claim round trip.
    expect(poller.polls).toBe(2);
  });

  it('ignores wake() after shutdown has begun', async () => {
    poller.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    await poller.onApplicationShutdown();

    const before = poller.polls;
    poller.wake();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.polls).toBe(before);
  });
});
