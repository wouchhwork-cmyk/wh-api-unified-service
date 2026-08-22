import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfigService } from '@/config';

const CORRELATION_HEADERS = ['x-correlation-id', 'x-request-id'] as const;

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

      // Belt and braces: even if a serialiser is widened later, these paths are
      // censored.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-hub-signature-256"]',
          'res.headers["set-cookie"]',
          '*.password',
          '*.passwordHash',
          '*.accessToken',
          '*.refreshToken',
          '*.secret',
          '*.secretHash',
          '*.code',
          '*.payload',
          '*.appsecret_proof',
        ],
        censor: '[redacted]',
      },

      // Health probes fire constantly and say nothing when they pass.
      autoLogging: {
        ignore: (request: IncomingMessage) => (request.url ?? '').includes('/health/'),
      },
    },
  };
}
