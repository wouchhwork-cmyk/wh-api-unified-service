/**
 * The one keyset cursor codec.
 *
 * It was written three times — inbox, catalogue and the platform console — with
 * the same shape and the same bug, which is the argument for it living here: an
 * opaque cursor is a wire format, and a wire format with three implementations
 * has three ways to disagree with itself.
 *
 * Opaque on purpose. Clients must not construct one, so it carries no meaning
 * beyond "resume after this row" and is never validated for the caller's
 * benefit — a cursor that does not decode restarts the listing from the top.
 */
export interface KeysetCursor {
  /** The sort key. Null is legitimate: it means the row sorted with NULLS LAST. */
  readonly at: Date | null;
  readonly id: number;
}

export function encodeKeysetCursor(at: Date | null, id: number): string {
  return Buffer.from(JSON.stringify({ t: at?.toISOString() ?? null, i: id })).toString('base64url');
}

export function decodeKeysetCursor(cursor: string | null | undefined): KeysetCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: unknown;
      i?: unknown;
    };
    if (typeof parsed.i !== 'number' || !Number.isSafeInteger(parsed.i) || parsed.i < 0) {
      return null;
    }
    if (parsed.t === null || parsed.t === undefined) return { at: null, id: parsed.i };
    if (typeof parsed.t !== 'string') return null;

    const at = new Date(parsed.t);
    /*
     * A timestamp that does not parse is REJECTED rather than passed on. The
     * three hand-rolled versions all did `new Date(parsed.t)` unchecked, so
     * `{"t":"nope","i":1}` bound an Invalid Date into the query and the caller
     * got a 500 from a value they were free to make up.
     */
    if (Number.isNaN(at.getTime())) return null;
    return { at, id: parsed.i };
  } catch {
    // A malformed cursor restarts from the top rather than erroring: the value
    // is opaque to clients, so there is nothing useful to tell them.
    return null;
  }
}
