import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
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
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    // Never hold the process open just because a poll is pending.
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;

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
    const delay = handled >= batchSize ? 0 : handled > 0 ? pollIntervalMs : idlePollIntervalMs;
    this.schedule(delay);
  }
}
