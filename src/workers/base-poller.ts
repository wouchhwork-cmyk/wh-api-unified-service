import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import { NOTIFY_DEBOUNCE_MS } from '@/shared/constants';
import type { AppConfigService } from '@/config';

/**
 * The shape every worker shares: claim a batch, process it, sleep, repeat.
 *
 * There is no broker. The ledger tables ARE the queue and the claim is a single
 * FOR UPDATE SKIP LOCKED statement, which is the whole concurrency story: two
 * workers can never take the same row and neither waits for the other
 * (backend-design.md §12).
 *
 * An empty poll backs off to the idle interval and snaps back to the fast one on
 * the first hit, so an idle deployment is one cheap index probe every ten
 * seconds rather than a constant drum.
 */
export abstract class BasePoller implements OnModuleInit, OnApplicationShutdown {
  /** Identifies this worker in lease_owner, so a stuck lease is traceable. */
  protected readonly leaseOwner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private inFlight: Promise<void> | null = null;
  /** Set by wake(): the next scheduling decision polls immediately. */
  private wakeRequested = false;

  protected abstract readonly name: string;
  protected abstract readonly config: AppConfigService;
  protected abstract readonly logger: PinoLogger;

  /** Returns how many rows were handled, so the loop can pick its next delay. */
  protected abstract pollOnce(): Promise<number>;

  onModuleInit(): void {
    this.logger.info({ worker: this.name, leaseOwner: this.leaseOwner }, 'worker started');
    this.schedule(0);
  }

  /**
   * Graceful shutdown: stop claiming NEW work, then wait for the batch in
   * flight. Killing mid-batch is survivable — the lease lapses and a reaper
   * returns the rows — but finishing cleanly avoids the delay and the noise.
   */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.inFlight) await this.inFlight;
    this.logger.info({ worker: this.name }, 'worker stopped');
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    // Replace, never stack: wake() reschedules an already-pending timer, and two
    // live timers would run two overlapping polls.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    // Never hold the process open just because a poll is pending.
    this.timer.unref();
  }

  /**
   * Poll now rather than at the next timer, because something was just enqueued.
   *
   * Called from the LISTEN/NOTIFY listener. Two cases, both handled:
   *   - idle: the pending timer is replaced with a short debounced one, so a
   *     burst of ten inserts causes one poll rather than ten;
   *   - mid-poll: the flag is recorded and honoured when the current batch
   *     finishes, because a row inserted while we were claiming may not have
   *     been visible to that claim.
   *
   * Safe to call at any rate. Losing a wake costs latency, never work.
   */
  wake(): void {
    if (this.stopping) return;
    this.wakeRequested = true;
    if (this.running) return;
    this.schedule(NOTIFY_DEBOUNCE_MS);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    /*
     * THIS poll services whatever wake is outstanding, so the flag is cleared
     * here rather than after the batch. Clearing it afterwards made every wake
     * cost two polls: the one it triggered, then a second one because the flag
     * still looked unserviced. A wake arriving DURING the batch sets it again
     * and is honoured below, which is the case that actually needs it.
     */
    this.wakeRequested = false;

    let handled = 0;
    this.inFlight = (async () => {
      try {
        handled = await this.pollOnce();
      } catch (error) {
        // A failure in the CLAIM itself (the database is down, say) must not
        // kill the loop; individual row failures are handled by the worker.
        this.logger.error({ worker: this.name, err: error }, 'poll failed');
      }
    })();

    await this.inFlight;
    this.inFlight = null;
    this.running = false;

    // A full batch probably means more is waiting, so poll again immediately.
    const { pollIntervalMs, idlePollIntervalMs, batchSize } = this.config.worker;
    let delay = handled >= batchSize ? 0 : handled > 0 ? pollIntervalMs : idlePollIntervalMs;

    // Something arrived while this batch was running: do not sit out the idle
    // interval when we have already been told there is work.
    if (this.wakeRequested) {
      this.wakeRequested = false;
      delay = 0;
    }

    this.schedule(delay);
  }
}
