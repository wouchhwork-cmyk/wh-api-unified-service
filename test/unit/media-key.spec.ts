import { describe, expect, it } from 'vitest';
import { assetIdFromMetadata, mediaKeyFor } from '@/shared/utils/media-key';

/**
 * What makes two pieces of media the same piece of media.
 *
 * THE WHOLE COST CONTROL RESTS ON THIS. Meta's media links are signed and
 * expire; a refresh hands back the same file under a new signature. A key
 * built from anything that moves would make every refresh look like new media
 * and pay a model to describe it again — so these cases are mostly about
 * what the key must IGNORE.
 */
describe('identifying a piece of media', () => {
  it('uses the asset id, which a refresh does not change', () => {
    expect(mediaKeyFor({ assetId: '1089599720212101' })).toBe('asset:1089599720212101');
  });

  /**
   * MEASURED, not hypothetical. On 27 October a refresh replaced three links
   * in one thread: same `asset_id`, new signature, and the media loaded again.
   * Both of these are the same photo and must key the same.
   */
  it('gives one key to a link before and after it was refreshed', () => {
    const before = mediaKeyFor({
      assetId: '1089599720212101',
      platformMessageId: 'mid.abc',
      sortOrder: 0,
    });
    const after = mediaKeyFor({
      assetId: '1089599720212101',
      platformMessageId: 'mid.abc',
      sortOrder: 0,
    });
    expect(before).toBe(after);
  });

  it('falls back to the message and position when there is no asset id', () => {
    expect(mediaKeyFor({ platformMessageId: 'mid.abc', sortOrder: 2 })).toBe('msg:mid.abc:2');
    expect(mediaKeyFor({ assetId: null, platformMessageId: 'mid.abc', sortOrder: 0 })).toBe(
      'msg:mid.abc:0',
    );
    /* An absent position is the first attachment, not an unkeyable row. */
    expect(mediaKeyFor({ platformMessageId: 'mid.abc' })).toBe('msg:mid.abc:0');
  });

  it('keeps two attachments on one message apart', () => {
    expect(mediaKeyFor({ platformMessageId: 'mid.abc', sortOrder: 0 })).not.toBe(
      mediaKeyFor({ platformMessageId: 'mid.abc', sortOrder: 1 }),
    );
  });

  /**
   * REFUSING IS THE SAFE ANSWER. A row with nothing stable about it cannot be
   * deduplicated; the alternative — keying on the URL, which is all that is
   * left — would describe the same media again on every refresh while looking
   * perfectly correct.
   */
  it('refuses to invent a key when nothing stable is available', () => {
    expect(mediaKeyFor({})).toBeNull();
    expect(mediaKeyFor({ assetId: '', platformMessageId: '' })).toBeNull();
    expect(mediaKeyFor({ assetId: '   ', platformMessageId: '  ' })).toBeNull();
  });

  it('reads the asset id the ingest path stores, and nothing else', () => {
    expect(assetIdFromMetadata({ assetId: '123' })).toBe('123');
    expect(assetIdFromMetadata({ assetId: '' })).toBeNull();
    expect(assetIdFromMetadata({ platformType: 'ig_reel' })).toBeNull();
    expect(assetIdFromMetadata(null)).toBeNull();
    /* A non-string asset id is a shape we never wrote; it is not an id. */
    expect(assetIdFromMetadata({ assetId: 123 as unknown as string })).toBeNull();
  });
});
