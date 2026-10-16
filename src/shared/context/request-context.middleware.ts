import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { readClientTraceId } from '@/shared/logging/client-trace';
import { RequestContext } from './request-context';

/**
 * Opens the AsyncLocalStorage store for the whole request.
 *
 * MIDDLEWARE, not an interceptor, and the distinction matters: Nest runs
 * middleware before guards, whereas interceptors run after them. An interceptor
 * would leave the guards — which build the ActorContext — outside the store, and
 * would also lose it for the response mapping, because the map() operator runs
 * after the run() callback has already returned.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request & { id?: string }, response: Response, next: NextFunction): void {
    /*
     * OURS, ALWAYS. The caller does not get to choose it.
     *
     * This used to accept `x-correlation-id` or `x-request-id` from the request
     * — and that id is not a cosmetic log tag: it is written onto audit_logs,
     * inbound_events and outbound_events. Letting a caller supply it means a
     * caller choosing the key their own actions are filed under, which is
     * exactly the thing an audit trail exists to prevent. Two callers could
     * also send the same value and collapse into one apparent request.
     *
     * Reusing `request.id` is still right: the logger assigns it first, and one
     * id identifying the request in the logs, the envelope and the ledger is
     * the whole point.
     */
    const correlationId = request.id ?? randomUUID();
    request.id = correlationId;

    // Echo it back so a caller can correlate its own logs with ours.
    response.setHeader('x-correlation-id', correlationId);

    /*
     * The caller's own id is kept as a TRACE HINT and nothing else: logged so a
     * client can find its request in our logs, never stored, never used as a
     * key. Bounding and stripping live in readClientTraceId, which the logger
     * shares, so the two readers cannot disagree about what a header may say.
     */
    const clientTraceId = readClientTraceId(request.headers);

    RequestContext.run(
      {
        correlationId,
        route: `${request.method} ${request.path}`,
        ipAddress: clientIp(request),
        userAgent: truncate(request.get('user-agent'), MAX_USER_AGENT_LENGTH),
        ...(clientTraceId ? { clientTraceId } : {}),
      },
      () => {
        next();
      },
    );
  }
}

/** audit_logs.user_agent is text, so this is a memory bound rather than a column one. */
const MAX_USER_AGENT_LENGTH = 512;

/**
 * The client address, but ONLY if it is actually an address.
 *
 * `app.set('trust proxy', 1)` makes request.ip the last hop of
 * X-Forwarded-For, which is a client-supplied header — and audit_logs.ip_address
 * is `inet`. So `X-Forwarded-For: not-an-ip` made every audit insert on that
 * request fail with 22P02: the audit row was silently lost, and where the write
 * shared a transaction with the work it recorded, that transaction was poisoned
 * and the endpoint answered 500. A header nobody validated could turn login off.
 *
 * Dropped rather than corrected: a value that is not an address tells us nothing
 * about where the request came from, and inventing one would be worse than null.
 */
function clientIp(request: Request): string | undefined {
  const candidate = request.ip;
  return candidate && isIP(candidate) !== 0 ? candidate : undefined;
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  return value.length <= limit ? value : value.slice(0, limit);
}
