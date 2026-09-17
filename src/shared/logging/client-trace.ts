import type { IncomingHttpHeaders } from 'node:http';

/**
 * Headers a caller may use to label its own request.
 *
 * A TRACE HINT AND NOTHING ELSE. The value is logged so a client can find its
 * request in our logs. It is never our correlation id, never stored, and never
 * a key — see `genReqId` in logger.config.ts for what went wrong when it was.
 */
const CLIENT_TRACE_HEADERS = ['x-correlation-id', 'x-request-id'] as const;

/**
 * Matched to inbound_events.correlation_id and outbound_events.correlation_id
 * (VARCHAR(100)) so a hint that appears in the logs beside a ledger row can
 * never be longer than the ids it sits next to.
 */
const MAX_CLIENT_TRACE_LENGTH = 100;

/**
 * C0 and C1 control characters. A newline in a logged value is how one log line
 * becomes two, and the forged second line reads exactly like a real one.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * The caller's own request label, bounded and stripped, or undefined if it sent
 * nothing usable. Truncates rather than rejects: an over-long hint is still a
 * useful hint, whereas dropping it loses the client's only thread back to us.
 */
export function readClientTraceId(headers: IncomingHttpHeaders): string | undefined {
  for (const name of CLIENT_TRACE_HEADERS) {
    const raw = headers[name];
    if (typeof raw !== 'string') continue;
    const cleaned = raw.replace(CONTROL_CHARACTERS, '').trim().slice(0, MAX_CLIENT_TRACE_LENGTH);
    if (cleaned.length > 0) return cleaned;
  }
  return undefined;
}
