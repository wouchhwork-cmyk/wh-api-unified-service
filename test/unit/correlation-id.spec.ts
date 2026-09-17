import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { RequestContextMiddleware } from '@/shared/context/request-context.middleware';
import { RequestContext } from '@/shared/context/request-context';
import { readClientTraceId } from '@/shared/logging/client-trace';

/**
 * The correlation id is ours, and a caller must not be able to choose it.
 *
 * It is not a cosmetic log tag: it is written onto audit_logs, inbound_events
 * and outbound_events. A caller who picks it picks the key their own actions
 * are filed under — and two callers sending the same value collapse into one
 * apparent request, which is how a trail stops being a trail.
 *
 * Both readers are exercised here, because the trust boundary sits in the
 * LOGGER: pino's middleware comes from an imported module, so it assigns
 * `request.id` before the context middleware ever runs. A version of this fix
 * that only hardened the middleware changed nothing at all.
 */
describe('correlation id', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function run(headers: Record<string, string>): {
    stored: string | undefined;
    trace: string | undefined;
    echoed: string | undefined;
  } {
    const middleware = new RequestContextMiddleware();
    let echoed: string | undefined;
    const request = {
      headers,
      method: 'GET',
      path: '/api/v1/conversations',
      ip: '203.0.113.7',
      get: (name: string) => headers[name.toLowerCase()],
    } as unknown as Request & { id?: string };
    const response = {
      setHeader: (name: string, value: string) => {
        if (name === 'x-correlation-id') echoed = value;
      },
    } as unknown as Response;

    let stored: string | undefined;
    let trace: string | undefined;
    middleware.use(request, response, (() => {
      stored = RequestContext.correlationId();
      trace = RequestContext.clientTraceId();
    }) as NextFunction);

    return { stored, trace, echoed };
  }

  it('does not adopt a correlation id the caller sent', () => {
    const { stored } = run({ 'x-correlation-id': 'chosen-by-the-caller' });

    expect(stored).not.toBe('chosen-by-the-caller');
    expect(stored).toMatch(UUID);
  });

  it('does not adopt x-request-id either', () => {
    // The second header was the same hole with a different name.
    const { stored } = run({ 'x-request-id': 'chosen-by-the-caller' });

    expect(stored).not.toBe('chosen-by-the-caller');
    expect(stored).toMatch(UUID);
  });

  it('keeps the caller’s value as a trace hint, so nothing is lost by refusing it', () => {
    const { stored, trace } = run({ 'x-correlation-id': 'caller-abc' });

    expect(trace).toBe('caller-abc');
    expect(stored).not.toBe(trace);
  });

  it('gives two callers sending the same value two different ids', () => {
    // The collapse this prevents: one apparent request, two real ones.
    const first = run({ 'x-correlation-id': 'same' });
    const second = run({ 'x-correlation-id': 'same' });

    expect(first.stored).not.toBe(second.stored);
  });

  it('echoes our id back, not theirs', () => {
    const { stored, echoed } = run({ 'x-correlation-id': 'caller-abc' });

    expect(echoed).toBe(stored);
    expect(echoed).not.toBe('caller-abc');
  });

  it('carries no hint when the caller sent none', () => {
    expect(run({}).trace).toBeUndefined();
  });

  describe('the hint is untrusted input bound for a log line', () => {
    it('strips control characters that would forge a second line', () => {
      const trace = readClientTraceId({
        'x-correlation-id': 'abc\n{"level":50,"msg":"forged"}',
      });

      expect(trace).not.toContain('\n');
      expect(trace).toBe('abc{"level":50,"msg":"forged"}');
    });

    it('truncates to the width of the columns it sits beside in the logs', () => {
      const trace = readClientTraceId({ 'x-correlation-id': 'x'.repeat(500) });

      expect(trace).toHaveLength(100);
    });

    it('ignores a header that is empty or only whitespace', () => {
      expect(readClientTraceId({ 'x-correlation-id': '   ' })).toBeUndefined();
      expect(readClientTraceId({ 'x-correlation-id': '' })).toBeUndefined();
    });

    it('ignores a repeated header, which arrives as an array', () => {
      expect(readClientTraceId({ 'x-correlation-id': ['a', 'b'] })).toBeUndefined();
    });

    it('prefers x-correlation-id when both are sent', () => {
      expect(
        readClientTraceId({ 'x-correlation-id': 'first', 'x-request-id': 'second' }),
      ).toBe('first');
    });
  });
});
