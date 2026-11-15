/**
 * The STABLE identity of a piece of media, across CDN link refreshes.
 *
 * Meta's media links are signed and expire; a refresh hands back the same
 * media under a new signature. Keying on the URL would therefore make every
 * refresh look like a new piece of media and pay for analysing it again — so
 * the key is built from the things a refresh does not touch.
 *
 * `asset_id`, carried inside the CDN URL and extracted at ingest, is the best
 * of them: it is Meta's own identifier for the file and is identical before
 * and after a refresh. Where there is none — some attachment kinds carry no
 * asset id at all — the message's platform id plus the attachment's position
 * within that message is just as stable, because neither moves.
 *
 * Null when neither is available. A row that cannot be keyed cannot be
 * deduplicated, and analysing it twice is worse than not analysing it: the
 * alternative is a key built from something that changes, which would do
 * exactly that while looking correct.
 */
export function mediaKeyFor(input: {
  readonly assetId?: string | null;
  readonly platformMessageId?: string | null;
  readonly sortOrder?: number | null;
}): string | null {
  const assetId = typeof input.assetId === 'string' ? input.assetId.trim() : '';
  if (assetId.length > 0) return `asset:${assetId}`;

  const messageId =
    typeof input.platformMessageId === 'string' ? input.platformMessageId.trim() : '';
  if (messageId.length === 0) return null;

  const order = Number.isInteger(input.sortOrder) ? (input.sortOrder as number) : 0;
  return `msg:${messageId}:${order}`;
}

/** Reads the asset id the ingest path stores in an attachment's metadata. */
export function assetIdFromMetadata(metadata: Record<string, unknown> | null): string | null {
  const value = metadata?.assetId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
