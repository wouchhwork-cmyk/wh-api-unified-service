import { describe, expect, it } from 'vitest';
import { InboxEventsService } from '@/modules/inbox/inbox-events.service';
import { SSE_MAX_STREAMS_PER_ENTERPRISE } from '@/shared/constants';
import { AppException, ErrorCode } from '@/shared/errors';
import type { AppConfigService } from '@/config';
import type { PinoLogger } from 'nestjs-pino';

/**
 * The per-tenant stream cap, and the refusal it produces.
 *
 * A CONTROL WITH A THRESHOLD NEEDS A TEST PROVING IT CAN FAIL. This one had
 * none, and it was also throwing a bare `Error` — which escapes the error
 * catalogue, so the filter had nothing to map and answered `INTERNAL_ERROR`
 * 500. A deliberate per-tenant limit doing exactly its job was being reported
 * as the service breaking, and logged at `error` as though it were our fault.
 *
 * The service is constructed directly: the cap is in-memory bookkeeping and
 * needs neither the database connection nor the config it is handed.
 */
describe('the per-business SSE stream cap', () => {
  const build = (): InboxEventsService =>
    new InboxEventsService(
      { worker: {} } as unknown as AppConfigService,
      {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      } as unknown as PinoLogger,
    );

  const visible = { conversations: true, comments: true, mentions: true } as never;

  it('admits subscribers right up to the cap', () => {
    const service = build();
    for (let i = 0; i < SSE_MAX_STREAMS_PER_ENTERPRISE; i += 1) {
      expect(() => service.subscribe(1, visible, () => undefined)).not.toThrow();
    }
  });

  /** The assertion that matters: the cap actually bites. */
  it('refuses the one past the cap, with a code a client can act on', () => {
    const service = build();
    for (let i = 0; i < SSE_MAX_STREAMS_PER_ENTERPRISE; i += 1) {
      service.subscribe(1, visible, () => undefined);
    }

    let thrown: AppException | null = null;
    try {
      service.subscribe(1, visible, () => undefined);
    } catch (error) {
      thrown = error as AppException;
    }

    expect(thrown).toBeInstanceOf(AppException);
    expect(thrown?.code).toBe(ErrorCode.RateLimited);
  });

  /** One business filling its own quota must not shut out another. */
  it('counts the cap per business, not globally', () => {
    const service = build();
    for (let i = 0; i < SSE_MAX_STREAMS_PER_ENTERPRISE; i += 1) {
      service.subscribe(1, visible, () => undefined);
    }

    expect(() => service.subscribe(2, visible, () => undefined)).not.toThrow();
  });

  /** Unsubscribing frees the slot, or the cap becomes a permanent lockout. */
  it('releases a slot when a subscriber goes away', () => {
    const service = build();
    const unsubscribes = Array.from({ length: SSE_MAX_STREAMS_PER_ENTERPRISE }, () =>
      service.subscribe(1, visible, () => undefined),
    );

    expect(() => service.subscribe(1, visible, () => undefined)).toThrow();
    unsubscribes[0]?.();
    expect(() => service.subscribe(1, visible, () => undefined)).not.toThrow();
  });
});
