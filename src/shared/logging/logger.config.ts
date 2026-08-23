import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfigService } from '@/config';

const CORRELATION_HEADERS = ['x-correlation-id', 'x-request-id'] as const;

/**
 * Field names that must never appear in a log line, whatever wrote them.
 *
 * Named keys only — no `code`, no `id`, nothing overloaded. Each is expanded to
 * bare, one-deep and two-deep paths below, because a pino wildcard matches
 * exactly one level.
 */
const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'accessToken',
  'refreshToken',
  'secret',
  'secretHash',
  'otpCode',
  'payload',
  'appsecret_proof',
  'authorization',
  'cookie',
] as const;

/**
 * Structured logging (backend-design.md §13.2).
 *
 * REDACTION IS AN ALLOWLIST, NOT A DENYLIST. A denylist misses the next field
 * someone adds — and the fields at stake here are tokens, verification secrets,
 * ledger payloads full of customer message text, emails, and phone numbers. So
 * request and response serialisers emit only named-safe fields, and nothing else
 * from the request object can reach a log line.
 */
export function buildLoggerConfig(config: AppConfigService): Params {
  const isDev = config.app.env === 'dev';

  return {
    /*
     * Spelled the way Express 5's router accepts, rather than nestjs-pino's own
     * default of `['*']`.
     *
     * The bare wildcard is gone from path-to-regexp, so Nest auto-converts it and
     * logs a warning for it on every boot — twice here, because the module
     * applies two middlewares. Passing the modern form silences both and means
     * nothing has to change when the auto-conversion is eventually removed.
     */
    forRoutes: ['{*path}'],
    pinoHttp: {
      level: config.app.logLevel,
      // Pretty output in dev only; JSON everywhere a machine reads the logs.
      ...(isDev
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, singleLine: true, translateTime: 'HH:MM:ss.l' },
            },
          }
        : {}),

      genReqId: (request: IncomingMessage): string => {
        // The context middleware may already have assigned one; reuse it so the
        // requestId a client is handed is the same string the logs carry.
        const existing = (request as IncomingMessage & { id?: string }).id;
        if (typeof existing === 'string' && existing.length > 0) return existing;

        for (const header of CORRELATION_HEADERS) {
          const value = request.headers[header];
          if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
        }
        return randomUUID();
      },

      customProps: (request: IncomingMessage) => ({
        correlationId: (request as IncomingMessage & { id?: string }).id,
      }),

      // Only these fields, only ever these fields.
      serializers: {
        req: (request: IncomingMessage & { id?: string; url?: string; method?: string }) => ({
          id: request.id,
          method: request.method,
          // The path without its query string: query strings carry codes and
          // identifiers we have promised never to log.
          path: request.url?.split('?')[0],
        }),
        res: (response: ServerResponse) => ({ statusCode: response.statusCode }),
        err: (error: Error & { code?: string; status?: number }) => ({
          type: error.name,
          message: error.message,
          code: error.code,
          status: error.status,
          // Stacks are diagnostic and contain no user data; they stay.
          stack: error.stack,
        }),
      },

      /*
       * Belt and braces: even if a serialiser is widened later, these paths are
       * censored.
       *
       * A pino wildcard matches ONE level, so each name is listed at the depths
       * a log object realistically reaches — bare, one deep, and two deep. The
       * list used to carry only the one-deep form, which meant a secret logged
       * at the top level, or nested inside a context object, went through in
       * clear.
       *
       * `*.code` is deliberately NOT here. It censored `err.code` — a
       * machine-readable error code with no user data in it, and the single most
       * useful field for diagnosing an upstream failure — in every line the
       * service wrote, while missing the OTP it was added for, which sits at the
       * top level or two deep. The OTP field is named otpCode precisely so it
       * can be named here without collateral damage.
       */
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-hub-signature-256"]',
          'res.headers["set-cookie"]',
          ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
        ],
        censor: '[redacted]',
      },

      // Health probes fire constantly and say nothing when they pass.
      autoLogging: {
        /*
         * The health ROUTES, not any URL containing that substring. `includes`
         * meant a request to `/conversations?q=/health/` silenced its own access
         * log — a caller choosing whether their request is recorded, which is
         * the same class of problem as a client-supplied audit anchor.
         */
        ignore: (request: IncomingMessage) =>
          /^\/[^/]+\/v\d+\/health(\/|$)/u.test((request.url ?? '').split('?')[0] ?? ''),
      },
    },
  };
}
