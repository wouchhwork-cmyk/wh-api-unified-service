import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import { GraphApiError } from '@/modules/connections/graph/graph-api.error';
import { mapGraphError } from '@/modules/connections/graph/graph-error.mapper';
import { ErrorCode } from '@/shared/errors';

/**
 * Graph responses are checked at the boundary instead of cast.
 *
 * Every response used to end in `return parsed as T` — an assertion about a
 * system we do not control, cannot version-pin, and which ships changes on its
 * own schedule. The first thing to notice a shape change was whatever consumed
 * the value, three layers down, as a null column or a missing function. The
 * point of these tests is the two halves of getting that right: catching a
 * genuine mismatch, and NOT catching the ordinary looseness Meta ships every
 * day.
 */
describe('Graph responses are validated, not cast', () => {
  afterEach(() => vi.unstubAllGlobals());

  const config = {
    meta: { appSecret: 'secret', graphVersion: 'v25.0' },
    http: { timeoutMs: 5000 },
  } as never;

  const respondWith = (body: unknown): void => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  };

  describe('a real mismatch is caught at the call that made it', () => {
    it('refuses an edge whose list is not a list', async () => {
      /*
       * The shape change that used to be silent. `data` as an object rather
       * than an array meant `.data.map` further down — a TypeError with no
       * path back to the call that produced it.
       */
      respondWith({ data: { id: '1' } });
      const client = new GraphApiClient(config);

      await expect(client.listPagePosts('PAGE', 'token')).rejects.toThrow(GraphApiError);
    });

    it('refuses a field that is the wrong type', async () => {
      // `caption` is text. An object here means a field was restructured.
      respondWith({ data: [{ id: '1', caption: { text: 'hello' } }] });
      const client = new GraphApiClient(config);

      await expect(client.listInstagramMedia('IG', 'token')).rejects.toThrow(GraphApiError);
    });

    it('marks the failure permanent, so it is not retried into the same wall', async () => {
      /*
       * A retry fetches the same unexpected shape and fails identically, so
       * retrying only spends quota on the way to the same dead letter.
       * `type: 'schema'` is what the error mapper reads to decide that.
       */
      respondWith({ data: { id: '1' } });
      const client = new GraphApiClient(config);

      const error = await client.listPagePosts('PAGE', 'token').catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(GraphApiError);
      expect((error as GraphApiError).type).toBe('schema');
      // Meta reported nothing — we did — so there is no Meta code to carry.
      expect((error as GraphApiError).code).toBeNull();

      const mapped = mapGraphError(error as GraphApiError);
      expect(mapped.retryable).toBe(false);
      /*
       * And named honestly. The fallback would call this UPSTREAM_UNAVAILABLE,
       * which sends whoever reads the log hunting a Meta outage when what
       * happened is that Meta changed a shape and we noticed.
       */
      expect(mapped.code).toBe(ErrorCode.UpstreamContractChanged);
    });

    it('names the field path and never the value', async () => {
      /*
       * THE ONE THING THIS MESSAGE MUST NOT DO. It is logged and written to a
       * ledger row, and a Graph payload carries customer message text, handles
       * and profile links. The path is enough to find the problem; the value
       * would be a PII leak into the logs on every shape change.
       */
      respondWith({ data: [{ id: '1', caption: { secret: 'a customer wrote this' } }] });
      const client = new GraphApiClient(config);

      const error = await client
        .listInstagramMedia('IG', 'token')
        .catch((cause: unknown) => cause);

      const message = (error as GraphApiError).message;
      expect(message).toContain('caption');
      expect(message).not.toContain('a customer wrote this');
      expect(message).not.toContain('secret');
    });
  });

  describe('ordinary Meta looseness still passes', () => {
    it('accepts unknown fields, which Meta adds on its own schedule', async () => {
      // A schema that rejected these would break on Meta's release cycle
      // rather than ours.
      respondWith({
        data: [{ id: '1', caption: 'hello', some_field_shipped_last_tuesday: { nested: true } }],
      });
      const client = new GraphApiClient(config);

      const page = await client.listInstagramMedia('IG', 'token');

      expect(page.data?.[0]?.id).toBe('1');
    });

    it('accepts an absent field, because Graph omits rather than nulls', async () => {
      // A post with no text has no `caption` key at all, and treating absence
      // as an error would abandon a walk over a photo post.
      respondWith({ data: [{ id: '1' }] });
      const client = new GraphApiClient(config);

      const page = await client.listInstagramMedia('IG', 'token');

      expect(page.data?.[0]?.caption).toBeUndefined();
    });

    it('accepts an empty body, which a write answers with', async () => {
      respondWith({});
      const client = new GraphApiClient(config);

      await expect(client.listInstagramMedia('IG', 'token')).resolves.toBeDefined();
    });

    it('normalises a numeric id to a string', async () => {
      /*
       * Meta has returned ids as JSON numbers on some edges and strings on
       * others, for the same object, across versions. Every column and every
       * comparison in this codebase expects a string.
       */
      respondWith({ data: [{ id: 123456789012345 }] });
      const client = new GraphApiClient(config);

      const page = await client.listInstagramMedia('IG', 'token');

      expect(page.data?.[0]?.id).toBe('123456789012345');
    });

    it('accepts a count that arrives as a numeric string', async () => {
      // Rejecting "42" would fail a backfill over a formatting difference that
      // costs nothing to absorb.
      respondWith({ data: [{ id: '1', like_count: '42' }] });
      const client = new GraphApiClient(config);

      const page = await client.listInstagramMedia('IG', 'token');

      expect(page.data?.[0]?.like_count).toBe(42);
    });
  });
});
