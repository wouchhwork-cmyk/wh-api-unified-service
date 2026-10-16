import { Injectable, PayloadTooLargeException, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MAX_WEBHOOK_BODY_BYTES } from '@/shared/constants';

/**
 * A tighter body limit on the one public write route.
 *
 * MAX_WEBHOOK_BODY_BYTES was declared and applied nowhere, so the webhook —
 * unauthenticated until its HMAC is checked, and deliberately exempt from rate
 * limiting — accepted the same 1 MiB as every authenticated route. Meta's
 * deliveries are a few kilobytes; anything approaching a megabyte is not Meta,
 * and the work it costs us is a full read plus an HMAC over the result.
 *
 * IT CHECKS THE DECLARED LENGTH rather than replacing the body parser. Nest's
 * own parsers implement `rawBody: true`, which the HMAC check depends on
 * absolutely — swapping in an express parser silently drops `req.rawBody` and
 * every Meta delivery would then fail verification. So this refuses early on
 * what the client declared, and a request with no Content-Length still falls
 * through to the global limit rather than being read unbounded.
 */
@Injectable()
export class WebhookBodyLimitMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction): void {
    const declared = Number(request.headers['content-length'] ?? '0');

    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
      // The filter turns this into the standard error envelope; no detail about
      // the limit, which would only tell a prober what to stay under.
      throw new PayloadTooLargeException();
    }

    next();
  }
}
