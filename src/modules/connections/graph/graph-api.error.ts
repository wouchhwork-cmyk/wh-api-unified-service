/**
 * A Graph failure, carrying the fields that decide what we do next.
 *
 * Meta's codes are the only reliable signal: the message text changes, and the
 * HTTP status alone cannot distinguish "your token died" from "you are sending
 * too fast" — both arrive as 400.
 */
export class GraphApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly type: string | null,
    readonly fbTraceId: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'GraphApiError';
  }

  /** A network failure or timeout: we never learned the outcome. */
  static fromTransport(cause: unknown, detail: string): GraphApiError {
    const error = new GraphApiError(0, null, null, 'transport', null, detail);
    error.cause = cause;
    return error;
  }
}
