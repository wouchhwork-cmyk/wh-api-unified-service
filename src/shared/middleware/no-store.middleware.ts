import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Every response is uncacheable, and says so.
 *
 * Nothing in this API set a single caching directive, while Express 5 emits a
 * weak ETag by default — so a tenant-scoped response full of customer names,
 * emails and message text was left eligible for heuristic caching by any
 * intermediary, keyed on the URI alone. `GET /api/v1/customers` is the same URI
 * for every business on the platform; the only thing distinguishing one tenant's
 * answer from another's is the Authorization header, which nothing told a cache
 * to vary on.
 *
 * `no-store` rather than `no-cache`: no-cache permits storing the response and
 * revalidating it, which still puts another business's customer list on a shared
 * disk. Vary is set as well, for any hop that ignores no-store.
 *
 * MIDDLEWARE rather than an interceptor, so it also covers error responses, the
 * raw-response routes and anything that bypasses the envelope. A handler that
 * genuinely wants caching sets its own header afterwards, which wins — the SSE
 * route does exactly that.
 */
@Injectable()
export class NoStoreMiddleware implements NestMiddleware {
  use(_request: Request, response: Response, next: NextFunction): void {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('vary', 'Authorization');
    next();
  }
}
