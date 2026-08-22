import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
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
    // Reuse whatever the logger already assigned, so one id identifies the
    // request in the logs, in the response envelope, and in the ledger rows.
    const correlationId =
      request.id ??
      firstHeader(request, 'x-correlation-id') ??
      firstHeader(request, 'x-request-id') ??
      randomUUID();
    request.id = correlationId;

    // Echo it back so a caller can correlate its own logs with ours.
    response.setHeader('x-correlation-id', correlationId);

    RequestContext.run({ correlationId, route: `${request.method} ${request.path}` }, () => {
      next();
    });
  }
}

function firstHeader(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
  return undefined;
}
