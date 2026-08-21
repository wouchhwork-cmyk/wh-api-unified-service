import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
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
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

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
      route: request.route?.path ?? request.url,
      err: exception,
    };
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
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

    // A statement_timeout is a real, diagnosable condition — not an anonymous 500.
    const pg = asPostgresError(exception);
    if (pg?.code === '57014') {
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
            message:
              status >= HttpStatus.INTERNAL_SERVER_ERROR ? ERROR_MESSAGE[code] : exception.message,
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
