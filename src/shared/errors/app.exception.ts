import { HttpException } from '@nestjs/common';
import { ErrorCode } from './error-codes.enum';
import { ERROR_MESSAGE, ERROR_STATUS } from './error-status.map';

/** One machine-readable detail about what failed, safe to show a client. */
export interface ErrorDetail {
  readonly field?: string | undefined;
  readonly issue: string;
}

export interface AppExceptionOptions {
  /** Field-level detail for the client. Never include internal ids or SQL. */
  readonly details?: readonly ErrorDetail[];
  /** Overrides the catalogue message. Must stay client-safe. */
  readonly message?: string;
  /** Logged and never serialised — this is how a driver error keeps its stack. */
  readonly cause?: unknown;
  /** Seconds, for 429 responses. */
  readonly retryAfterSeconds?: number;
}

/**
 * The ONE exception type services throw (backend-design.md §8.2).
 *
 * The HTTP status is derived from the code, never chosen at the throw site, so
 * a code always means the same status everywhere.
 */
export class AppException extends HttpException {
  readonly code: ErrorCode;
  readonly details?: readonly ErrorDetail[];
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, options: AppExceptionOptions = {}) {
    super(options.message ?? ERROR_MESSAGE[code], ERROR_STATUS[code], {
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.code = code;
    this.name = 'AppException';
    if (options.details !== undefined) this.details = options.details;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
