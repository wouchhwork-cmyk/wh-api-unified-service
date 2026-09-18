import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LISTEN_KEEPALIVE_DELAY_MS } from '@/shared/constants';

/**
 * Both long-lived LISTEN connections must ask for TCP keepalive.
 *
 * This is a regression test and nothing more ambitious: the failure it guards
 * against cannot be reproduced in a test, because it is a socket reclaimed by
 * a NAT gateway or load balancer WITHOUT a FIN. Neither end learns of it.
 * Postgres keeps its side, we keep a client that will never be notified again,
 * nothing errors and nothing logs — live updates just stop while the process
 * reports itself healthy.
 *
 * So the only thing worth asserting is that the option is still being passed.
 * It was absent from both clients until 18 Sep and nothing noticed, which is
 * the whole argument for pinning it.
 */
const constructed: Record<string, unknown>[] = [];

vi.mock('pg', () => ({
  Client: class {
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
    on(): void {}
    async connect(): Promise<void> {
      throw new Error('not connecting in a unit test');
    }
    async query(): Promise<void> {}
    async end(): Promise<void> {}
  },
}));

const databaseConfig = {
  host: 'localhost',
  port: 5432,
  user: 'wouchh',
  password: 'secret',
  name: 'wouchh_test',
  ssl: false,
  connectTimeoutMs: 1000,
};

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as never;

describe('LISTEN connections ask for TCP keepalive', () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  it('the queue listener does', async () => {
    const { QueueListenerService } = await import('@/workers/queue-listener.service');
    const poller = { wake: () => undefined } as never;

    const service = new QueueListenerService(
      poller,
      poller,
      poller,
      { database: databaseConfig } as never,
      silentLogger,
    );
    // connect() is private and deliberately not awaited by onModuleInit; the
    // client is constructed before anything can fail, which is all this needs.
    service.onModuleInit();
    await vi.waitFor(() => expect(constructed).toHaveLength(1));

    expect(constructed[0]).toMatchObject({
      keepAlive: true,
      keepAliveInitialDelayMillis: LISTEN_KEEPALIVE_DELAY_MS,
      application_name: 'wouchh-queue-listener',
    });
  });

  it('the inbox event stream does', async () => {
    const { InboxEventsService } = await import('@/modules/inbox/inbox-events.service');

    const service = new InboxEventsService({ database: databaseConfig } as never, silentLogger);
    service.onModuleInit();
    await vi.waitFor(() => expect(constructed).toHaveLength(1));

    expect(constructed[0]).toMatchObject({
      keepAlive: true,
      keepAliveInitialDelayMillis: LISTEN_KEEPALIVE_DELAY_MS,
      application_name: 'wouchh-inbox-events',
    });
  });
});
