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
    /**
     * How long Meta says it will be before the quota clears, in MINUTES.
     *
     * Read from the X-App-Usage / X-Business-Use-Case-Usage headers, which carry
     * `estimated_time_to_regain_access`. Null when Meta said nothing — which is
     * most responses, because the headers only appear once a quota is under
     * pressure. It exists so a throttled send waits the window Meta named
     * instead of a number we invented.
     */
    readonly retryAfterMinutes: number | null = null,
  ) {
    super(message);
    this.name = 'GraphApiError';
  }

  /**
   * The response arrived, was valid JSON, and was not the shape we asked for.
   *
   * `type: 'schema'` so the error mapper can treat it as PERMANENT: a retry
   * fetches the same unexpected shape and fails identically, so retrying only
   * spends quota on the way to the same dead letter. HTTP status is the real
   * one — the call itself succeeded — and the code is null, because Meta did
   * not report an error; we did.
   *
   * `detail` names the FIELD PATHS that disagreed and nothing else. Never the
   * values: this message reaches logs and a ledger row, and a Graph payload is
   * full of customer message text, handles and profile links.
   */
  static fromSchema(httpStatus: number, path: string, detail: string): GraphApiError {
    return new GraphApiError(
      httpStatus,
      null,
      null,
      'schema',
      null,
      `graph ${path} returned an unexpected shape: ${detail}`,
    );
  }

  /** A network failure or timeout: we never learned the outcome. */
  static fromTransport(cause: unknown, detail: string): GraphApiError {
    const error = new GraphApiError(0, null, null, 'transport', null, detail);
    error.cause = cause;
    return error;
  }
}
