import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Client } from 'pg';
import { AppConfigService } from '@/config';
import {
  NOTIFY_INBOUND_CHANNEL,
  NOTIFY_OUTBOUND_CHANNEL,
  NOTIFY_SYNC_CHANNEL,
  RETRY_MAX_DELAY_MS,
} from '@/shared/constants';
import { nextAttemptDelayMs } from '@/modules/ledger/backoff.util';
import { BackfillWorker } from './backfill.worker';
import type { BasePoller } from './base-poller';
import { InboundProjectorWorker } from './inbound-projector.worker';
import { OutboundRelayWorker } from './outbound-relay.worker';

/**
 * Turns an enqueue into an immediate poll.
 *
 * WHY A DEDICATED CONNECTION: LISTEN is session state. On a pooled connection
 * the subscription would belong to whichever connection happened to serve the
 * call and would silently vanish when that connection was recycled — so this
 * owns one client of its own, outside TypeORM's pool, and that client does
 * nothing else.
 *
 * WHY THIS IS ONLY AN OPTIMISATION: every worker still polls on its timer. If
 * this service never connects, or drops and cannot reconnect, the only cost is
 * latency — up to one idle interval instead of milliseconds. Nothing is lost,
 * which is what lets the whole thing fail quietly.
 */
@Injectable()
export class QueueListenerService implements OnModuleInit, OnApplicationShutdown {
  private client: Client | null = null;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;

  private readonly routes: ReadonlyMap<string, BasePoller>;

  constructor(
    inboundProjector: InboundProjectorWorker,
    outboundRelay: OutboundRelayWorker,
    backfill: BackfillWorker,
    private readonly config: AppConfigService,
    @InjectPinoLogger(QueueListenerService.name) private readonly logger: PinoLogger,
  ) {
    this.routes = new Map<string, BasePoller>([
      [NOTIFY_INBOUND_CHANNEL, inboundProjector],
      [NOTIFY_OUTBOUND_CHANNEL, outboundRelay],
      [NOTIFY_SYNC_CHANNEL, backfill],
    ]);
  }

  onModuleInit(): void {
    // Not awaited: a database that is slow to accept this connection must not
    // delay the workers, which can already do their job by polling.
    void this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.end();
      } catch {
        // Shutting down anyway.
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;

    const database = this.config.database;
    const client = new Client({
      host: database.host,
      port: database.port,
      user: database.user,
      password: database.password,
      database: database.name,
      // Verified, for the same reason as the application pool: see
      // inbox-events.service.ts.
      ...(database.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
      connectionTimeoutMillis: database.connectTimeoutMs,
      application_name: 'wouchh-queue-listener',
    });

    // Registered BEFORE connect: a socket that dies during the handshake would
    // otherwise reach an unhandled 'error' and take the process with it.
    client.on('error', (error) => {
      this.logger.warn(
        { err: error },
        'queue listener connection failed — falling back to polling',
      );
      this.scheduleReconnect();
    });

    try {
      await client.connect();
      for (const channel of this.routes.keys()) {
        // The channel names are module constants, never user input, and LISTEN
        // cannot be parameterised — so they are quoted as identifiers.
        await client.query(`LISTEN ${quoteIdentifier(channel)}`);
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'queue listener could not subscribe — polling only');
      this.scheduleReconnect();
      return;
    }

    client.on('notification', (message) => {
      const worker = this.routes.get(message.channel);
      if (worker) worker.wake();
    });

    client.on('end', () => {
      if (!this.stopping) this.scheduleReconnect();
    });

    this.client = client;
    this.attempt = 0;
    this.logger.info({ channels: [...this.routes.keys()] }, 'queue listener subscribed');
  }

  /**
   * Reconnects with the same jittered backoff the ledgers use, capped. A tight
   * reconnect loop against a database that is down is its own outage.
   */
  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;

    const client = this.client;
    this.client = null;
    if (client) void client.end().catch(() => undefined);

    this.attempt += 1;
    const delay = Math.min(nextAttemptDelayMs(this.attempt), RETRY_MAX_DELAY_MS);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }
}

/** Doubles any embedded quote, so a channel name can never break out. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
