import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Client } from 'pg';
import { AppConfigService } from '@/config';
import { nextAttemptDelayMs } from '@/modules/ledger/backoff.util';
import {
  NOTIFY_INBOX_CHANNEL,
  RETRY_MAX_DELAY_MS,
  SSE_MAX_STREAMS_PER_ENTERPRISE,
  LISTEN_KEEPALIVE_DELAY_MS,
} from '@/shared/constants';
import { ConversationKind } from '@/shared/enums';

/** What a subscriber is told. Ids only — never content. */
export interface InboxChange {
  readonly conversationRefId: string;
  readonly kind: 'inbound' | 'outbound';
  /**
   * Which kind of thread it was. Carried so the fan-out can drop a change for a
   * kind this subscriber may not see — NOT part of what reaches the browser.
   */
  readonly conversationKind: ConversationKind;
}

export type InboxSubscriber = (change: InboxChange) => void;

/**
 * The kinds of thread one subscriber is allowed to hear about.
 *
 * Captured at CONNECT and fixed for the life of the stream, like every other
 * authorisation on it. The stream already expires on its own timer for exactly
 * this reason — a long-lived subscription must not outlive the decision that
 * opened it — so a permission change takes effect at the next reconnect rather
 * than mid-stream.
 */
export type VisibleKinds = ReadonlySet<ConversationKind>;

/** A subscriber with no recorded kinds hears nothing, which is the safe default. */
const EMPTY: VisibleKinds = new Set<ConversationKind>();

/**
 * What a notification payload has to look like to be delivered, and to whom.
 *
 * PURE, AND EXPORTED, because it is a security control and the only reason the
 * last defect in it shipped is that nothing tested it. The fan-out lives behind
 * a Postgres LISTEN connection, so testing it in place means standing up a
 * client; extracting the decision means testing every branch directly, which is
 * what an access rule deserves.
 *
 * Returns the parsed change when it should reach this subscriber, or null.
 */
export function deliverableChange(
  raw: string | undefined,
  enterpriseId: number,
  visibleKinds: VisibleKinds,
): InboxChange | null {
  if (!raw) return null;

  let parsed: {
    enterpriseId?: unknown;
    conversationRefId?: unknown;
    kind?: unknown;
    conversationKind?: unknown;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }

  if (parsed.enterpriseId !== enterpriseId) return null;
  if (typeof parsed.conversationRefId !== 'string') return null;

  /*
   * A payload with no conversation kind is DROPPED, not delivered.
   *
   * Fail-closed, and it matters during a rolling deploy: an older instance
   * still publishing the old shape would otherwise have its events fanned out
   * unfiltered, which is the exact leak this closes. The cost of dropping is a
   * client that re-reads a beat later on its own poll; the cost of delivering
   * is telling somebody a private thread exists.
   */
  const conversationKind = parsed.conversationKind;
  if (typeof conversationKind !== 'string') return null;
  if (!visibleKinds.has(conversationKind as ConversationKind)) return null;

  return {
    conversationRefId: parsed.conversationRefId,
    kind: parsed.kind === 'outbound' ? 'outbound' : 'inbound',
    conversationKind: conversationKind as ConversationKind,
  };
}


/**
 * Fans a conversation change out to the browsers watching it.
 *
 * WHY POSTGRES AND NOT A BROKER: a webhook can land on one API instance while
 * the agent's stream is held by another, so an in-process event emitter would
 * deliver to the wrong process and look like a bug that only appears under load.
 * LISTEN/NOTIFY reaches every instance, and the database is already there — no
 * Redis, no gateway, nothing new to operate.
 *
 * WHY A DEDICATED CONNECTION: LISTEN is session state. On a pooled connection
 * the subscription belongs to whichever connection served the call and vanishes
 * silently when that connection is recycled.
 *
 * DEGRADES QUIETLY. If this never connects, streams simply receive nothing and
 * the client falls back to polling — the guarantee is the database, this is the
 * latency.
 */
@Injectable()
export class InboxEventsService implements OnModuleInit, OnApplicationShutdown {
  private client: Client | null = null;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;

  /** enterpriseId -> the subscribers on THIS instance. */
  private readonly subscribers = new Map<number, Set<InboxSubscriber>>();
  /**
   * What each of them may hear about.
   *
   * A parallel map rather than a field on the subscriber, because the
   * subscriber is a plain function the caller owns — wrapping it in an object
   * would change the shape every caller passes for the sake of one lookup.
   *
   * A WeakMap, so a subscriber that is dropped without its unsubscribe running
   * cannot hold an entry open. Keyed by a function object, an ordinary Map
   * turns every missed cleanup into a leak that nothing else would surface —
   * and the cleanup below sits behind an early return, which is exactly the
   * shape that eventually gets one wrong.
   */
  private readonly visibleKinds = new WeakMap<InboxSubscriber, VisibleKinds>();

  constructor(
    private readonly config: AppConfigService,
    @InjectPinoLogger(InboxEventsService.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    // Not awaited: a slow database must not delay the API's boot, and every
    // route works without this.
    void this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // The WeakMap needs no clearing: its entries go with the subscribers.
    this.subscribers.clear();

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

  /**
   * Registers a listener for one business and returns its own unsubscribe.
   *
   * Returning the disposer rather than exposing a remove() keeps a caller from
   * unsubscribing somebody else's handler by passing the wrong function.
   *
   * Throws when the tenant is already at its cap, so one business cannot pin
   * every connection this instance has.
   */
  subscribe(
    enterpriseId: number,
    visibleKinds: VisibleKinds,
    subscriber: InboxSubscriber,
  ): () => void {
    const existing = this.subscribers.get(enterpriseId) ?? new Set<InboxSubscriber>();

    if (existing.size >= SSE_MAX_STREAMS_PER_ENTERPRISE) {
      throw new Error('too many open streams for this business');
    }

    this.visibleKinds.set(subscriber, visibleKinds);
    existing.add(subscriber);
    this.subscribers.set(enterpriseId, existing);

    return () => {
      // Dropped FIRST, before the early return below, so it happens whatever
      // state the subscriber set is in.
      this.visibleKinds.delete(subscriber);

      const set = this.subscribers.get(enterpriseId);
      if (!set) return;
      set.delete(subscriber);
      // Drop the empty set rather than leaving a key per tenant forever.
      if (set.size === 0) this.subscribers.delete(enterpriseId);
    };
  }

  /** Open stream count, for the health report. */
  streamCount(): number {
    let total = 0;
    for (const set of this.subscribers.values()) total += set.size;
    return total;
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
      /*
       * VERIFIED, like the application pool. This read `rejectUnauthorized:
       * false`, which sends DB_USER and DB_PASSWORD over a TLS session whose
       * certificate nobody checked — and data-source.ts proves the environment
       * can verify it, because the pool every request uses already does.
       */
      ...(database.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
      connectionTimeoutMillis: database.connectTimeoutMs,
      // This connection is idle by design; without keepalive a silently
      // reclaimed socket leaves a listener nothing will ever notify again.
      keepAlive: true,
      keepAliveInitialDelayMillis: LISTEN_KEEPALIVE_DELAY_MS,
      application_name: 'wouchh-inbox-events',
    });

    // Registered BEFORE connect: a socket that dies during the handshake would
    // otherwise reach an unhandled 'error' and take the process down.
    client.on('error', (error) => {
      this.logger.warn(
        { err: error },
        'inbox event listener failed — clients fall back to polling',
      );
      this.scheduleReconnect();
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${quoteIdentifier(NOTIFY_INBOX_CHANNEL)}`);
    } catch (error) {
      this.logger.warn({ err: error }, 'inbox event listener could not subscribe');
      // End it even on failure: a client that connected and then failed its
      // LISTEN still holds a socket, and this used to abandon one on every
      // attempt.
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
      return;
    }

    /*
     * SHUTDOWN CAN HAVE HAPPENED WHILE WE WERE CONNECTING.
     *
     * onModuleInit starts this without awaiting — deliberately, so a slow
     * database cannot delay the API's boot — which means onApplicationShutdown
     * may already have run and found `this.client` still null. Without this
     * check the connection completes afterwards, is assigned, and outlives the
     * application: a pg client nobody owns, holding a LISTEN. In tests, where
     * apps are created and closed repeatedly in one process, that is a leak per
     * suite; in production it is one per failed-then-recovered boot.
     */
    if (this.stopping) {
      await client.end().catch(() => undefined);
      return;
    }

    client.on('notification', (message) => {
      this.dispatch(message.payload);
    });
    client.on('end', () => {
      if (!this.stopping) this.scheduleReconnect();
    });

    this.client = client;
    this.attempt = 0;
    this.logger.info({ channel: NOTIFY_INBOX_CHANNEL }, 'inbox event listener subscribed');
  }

  /**
   * Routes one notification to the right tenant's subscribers.
   *
   * The payload is parsed DEFENSIVELY and the tenant filter applied here: the
   * channel is shared by every business, so a malformed or unexpected payload
   * must be dropped rather than delivered to whoever happens to be listening.
   */
  private dispatch(raw: string | undefined): void {
    if (!raw) return;

    /*
     * The tenant is read once, cheaply, only to find the subscriber set. The
     * real decision — including re-checking the tenant — is `deliverableChange`,
     * which is applied PER SUBSCRIBER because the visible kinds differ between
     * them.
     */
    let enterpriseId: unknown;
    try {
      enterpriseId = (JSON.parse(raw) as { enterpriseId?: unknown }).enterpriseId;
    } catch {
      return;
    }
    if (typeof enterpriseId !== 'number') return;

    const listeners = this.subscribers.get(enterpriseId);
    if (!listeners) return;

    for (const listener of listeners) {
      const change = deliverableChange(raw, enterpriseId, this.visibleKinds.get(listener) ?? EMPTY);
      if (!change) continue;

      try {
        listener(change);
      } catch (error) {
        // One broken stream must not stop the others being told.
        this.logger.warn({ err: error }, 'an inbox subscriber threw');
      }
    }
  }

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
