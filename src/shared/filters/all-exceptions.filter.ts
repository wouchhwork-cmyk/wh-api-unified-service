import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { RequestContext } from '@/shared/context';
import {
  AppException,
  ErrorCode,
  ERROR_MESSAGE,
  ERROR_STATUS,
  asPostgresError,
  mapConstraintViolation,
  PG_ERROR,
} from '@/shared/errors';
import type { ErrorEnvelope, ResponseMeta } from '@/shared/contracts/envelope';

/**
 * The single exit for every failure.
 *
 * THE FILTER NEVER LEAKS INTERNALS. A 500 returns INTERNAL_ERROR plus the
 * requestId; the stack, the driver error, and the SQL go to the log under that
 * same requestId (backend-design.md §8.2).
 */
@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@InjectPinoLogger(AllExceptionsFilter.name) private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const meta: ResponseMeta = {
      requestId: RequestContext.correlationId() ?? 'unknown',
      timestamp: new Date().toISOString(),
    };

    const { status, body, retryAfter } = this.translate(exception);

    // Log the full truth exactly once, keyed on the same requestId the client
    // is handed, so a support question maps to one log line.
    const logPayload = {
      requestId: meta.requestId,
      code: body.error.code,
      status,
      method: request.method,
      /*
       * THE PATH, NEVER THE QUERY STRING. `request.url` carries it, and the
       * request serialiser strips it deliberately — query strings carry codes
       * and identifiers we have promised never to log. This fallback put it
       * back on the error path, which is the one path most likely to be read.
       *
       * It only fires for an unmatched route, so the realistic exposure was a
       * mistyped URL carrying an OAuth `code`. Narrow, and it contradicted the
       * stated rule, which is enough.
       */
      route: request.route?.path ?? request.url.split('?')[0],
      err: exception,
    };
    if (isServerError(status)) {
      this.logger.error(logPayload, 'request failed');
    } else {
      this.logger.warn(logPayload, 'request rejected');
    }

    if (retryAfter !== undefined) response.setHeader('Retry-After', retryAfter);
    response.status(status).json({ ...body, meta });
  }

  private translate(exception: unknown): {
    status: number;
    body: Omit<ErrorEnvelope, 'meta'>;
    retryAfter?: number;
  } {
    // --- our own domain errors -------------------------------------------
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        body: {
          success: false,
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.details ? { details: exception.details } : {}),
          },
        },
        ...(exception.retryAfterSeconds !== undefined
          ? { retryAfter: exception.retryAfterSeconds }
          : {}),
      };
    }

    // --- request validation ----------------------------------------------
    if (exception instanceof ZodError) {
      return {
        status: ERROR_STATUS[ErrorCode.ValidationFailed],
        body: {
          success: false,
          error: {
            code: ErrorCode.ValidationFailed,
            message: ERROR_MESSAGE[ErrorCode.ValidationFailed],
            details: exception.issues.map((issue) => {
              const field = issue.path.join('.');
              return { ...(field ? { field } : {}), issue: issue.message };
            }),
          },
        },
      };
    }

    // --- a constraint we know by name ------------------------------------
    // A repository should have translated this already; catching it here means
    // a duplicate still reads as a 409 rather than a 500.
    const constraintCode = mapConstraintViolation(exception);
    if (constraintCode) {
      return {
        status: ERROR_STATUS[constraintCode],
        body: {
          success: false,
          error: { code: constraintCode, message: ERROR_MESSAGE[constraintCode] },
        },
      };
    }

    const pg = asPostgresError(exception);

    /*
     * A MALFORMED VALUE IS THE CALLER'S MISTAKE, and must not read as ours.
     *
     * Every route validates its reference ids at the edge, so this should be
     * unreachable — and it was not: one route took a `programRefId` straight
     * from the query string into a `uuid` predicate, and anything that was not
     * a uuid raised 22P02 and fell through to INTERNAL_ERROR. A 500 tells the
     * client to retry and tells us to go looking for a bug of our own.
     *
     * The edge validation is still the real fix. This is the backstop, so the
     * next route that forgets it answers 422 rather than 500.
     */
    if (pg?.code === PG_ERROR.InvalidTextRepresentation) {
      return {
        status: ERROR_STATUS[ErrorCode.ValidationFailed],
        body: {
          success: false,
          error: {
            code: ErrorCode.ValidationFailed,
            message: ERROR_MESSAGE[ErrorCode.ValidationFailed],
            /* No column name, no SQL, no driver text — that is ours to log. */
            details: [{ issue: 'a value in this request is not in the expected format' }],
          },
        },
      };
    }

    // A statement_timeout is a real, diagnosable condition — not an anonymous 500.
    if (pg?.code === PG_ERROR.QueryCanceled) {
      return {
        status: ERROR_STATUS[ErrorCode.RequestTimeout],
        body: {
          success: false,
          error: {
            code: ErrorCode.RequestTimeout,
            message: ERROR_MESSAGE[ErrorCode.RequestTimeout],
          },
        },
      };
    }

    /*
     * --- body-parser and other http-errors -------------------------------
     * A payload that is too large, an unsupported encoding, or an aborted
     * request arrives as an `http-errors` instance, NOT a Nest HttpException.
     * Without this branch every one of them became a 500, so a client sending a
     * 2 MB body was told the server had failed.
     */
    const httpError = asHttpError(exception);
    if (httpError) {
      const code = FRAMEWORK_STATUS_CODE[httpError.status] ?? ErrorCode.ValidationFailed;
      return {
        status: httpError.status,
        body: {
          success: false,
          error: {
            code,
            // The library's own messages are generic and client-safe
            // ("request entity too large"); they name nothing internal.
            message:
              httpError.status >= 500 ? ERROR_MESSAGE[ErrorCode.InternalError] : httpError.message,
          },
        },
      };
    }

    // --- framework exceptions --------------------------------------------
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = FRAMEWORK_STATUS_CODE[status] ?? ErrorCode.InternalError;
      return {
        status,
        body: {
          success: false,
          // Nest's own message is safe for 4xx (route not found, bad JSON);
          // for 5xx we substitute the generic catalogue message.
          error: {
            code,
            message: isServerError(status) ? ERROR_MESSAGE[code] : exception.message,
          },
        },
      };
    }

    // --- anything else: assume nothing, reveal nothing --------------------
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        success: false,
        error: {
          code: ErrorCode.InternalError,
          message: ERROR_MESSAGE[ErrorCode.InternalError],
        },
      },
    };
  }
}

/**
 * An `http-errors` instance, as thrown by body-parser and friends: a plain Error
 * carrying a numeric `status` in the HTTP range and an `expose` flag.
 */
function asHttpError(exception: unknown): { status: number; message: string } | null {
  if (!(exception instanceof Error)) return null;
  const candidate = exception as Error & {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
  };
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof status !== 'number' || status < 400 || status > 599) return null;
  // `expose` is how the library marks a message as safe to show a client.
  if (candidate.expose !== true && status >= 500) return { status, message: '' };
  return { status, message: exception.message };
}

/** Framework-raised statuses that deserve a specific code rather than INTERNAL_ERROR. */
const FRAMEWORK_STATUS_CODE: Readonly<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.ValidationFailed,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.AuthTokenInvalid,
  [HttpStatus.FORBIDDEN]: ErrorCode.PermissionDenied,
  [HttpStatus.NOT_FOUND]: ErrorCode.RouteNotFound,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.PayloadTooLarge,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.ValidationFailed,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RateLimited,
  [HttpStatus.REQUEST_TIMEOUT]: ErrorCode.RequestTimeout,
  [HttpStatus.BAD_GATEWAY]: ErrorCode.UpstreamUnavailable,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.UpstreamUnavailable,
};

/**
 * Whether a status is OURS rather than the caller's.
 *
 * The cast is the point, and it is confined to this one line. `status` is a
 * plain number and HttpStatus is a numeric enum, so comparing them relationally
 * is precisely what the enum-comparison rule catches elsewhere — but the named
 * constant still beats a bare 500, and "is this a server error" is worth having
 * as one concept rather than as a repeated inequality.
 */
function isServerError(status: number): boolean {
  return status >= (HttpStatus.INTERNAL_SERVER_ERROR as number);
}
