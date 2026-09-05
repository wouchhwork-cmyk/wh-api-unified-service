import { describe, expect, it } from 'vitest';
import {
  extractAssetId,
  isStableMediaUrl,
  normalizeAttachments,
} from '@/modules/inbox/attachment-normalizer';
import { MediaKind, MessageKind } from '@/shared/enums';

/**
 * Every payload below is a REAL one, taken from inbound_events after a live
 * Instagram session on 2026-09-05. The projector previously read
 * `attachments.length` and nothing else, so all of these became "an image with
 * no body" and the link — the entire content of most of them — was dropped.
 */
describe('normalizing a message attachment', () => {
  it('reads a story mention as a story, not as a photo somebody sent', () => {
    const media = normalizeAttachments([
      {
        type: 'story_mention',
        payload: {
          url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18101327498358721&signature=Ab1_vLts',
        },
      },
    ]);

    expect(media.isStoryMention).toBe(true);
    // The reply goes to a story that may already be gone, so the inbox has to
    // be able to say what this is.
    expect(media.messageKind).toBe(MessageKind.StoryReply);
    expect(media.attachments[0]?.mediaKind).toBe(MediaKind.Image);
    expect(media.attachments[0]?.sourceUrl).toContain('lookaside.fbsbx.com');
  });

  it('keeps the story asset id, which outlives the link', () => {
    // The signature and host are useless within a day; the asset id still says
    // WHICH story it was, so a later feature can group or re-resolve it.
    const media = normalizeAttachments([
      {
        type: 'story_mention',
        payload: {
          url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18101327498358721&signature=x',
        },
      },
    ]);

    expect(media.attachments[0]?.metadata.assetId).toBe('18101327498358721');
    expect(media.attachments[0]?.metadata.platformType).toBe('story_mention');
    expect(media.attachments[0]?.metadata.stableUrl).toBe(false);
  });

  it('tells a GIF from a photo, which Meta does not', () => {
    /*
     * Meta labels a GIF `image` and gives a Giphy link. Rendered as a still it
     * loses the point of being a GIF, and unlike a Meta CDN link it does not
     * expire — so the UI must not warn that it might vanish.
     */
    const media = normalizeAttachments([
      {
        type: 'image',
        payload: { url: 'https://media0.giphy.com/media/v1.Y2lkPTI2/52AbBj6Jn0kPKddsgj/200.gif' },
      },
    ]);

    expect(media.attachments[0]?.mediaKind).toBe(MediaKind.Gif);
    expect(media.attachments[0]?.metadata.stableUrl).toBe(true);
    expect(media.messageKind).toBe(MessageKind.Image);
  });

  it('reads a photo from the Meta CDN as an expiring image', () => {
    const media = normalizeAttachments([
      {
        type: 'image',
        payload: {
          url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=28292446397105373&signature=y',
        },
      },
    ]);

    expect(media.attachments[0]?.mediaKind).toBe(MediaKind.Image);
    expect(media.attachments[0]?.metadata.stableUrl).toBe(false);
    expect(media.isStoryMention).toBe(false);
  });

  it('reads a video as a video', () => {
    const media = normalizeAttachments([
      {
        type: 'video',
        payload: {
          url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1657933612593438&signature=z',
        },
      },
    ]);

    expect(media.messageKind).toBe(MessageKind.Video);
    expect(media.attachments[0]?.mediaKind).toBe(MediaKind.Video);
  });

  it('tells a sticker by its id, not by its type', () => {
    // Messenger sends a sticker as an `image` carrying a sticker_id.
    const media = normalizeAttachments([
      {
        type: 'image',
        payload: { url: 'https://example.test/s.png', sticker_id: 369239263222822 },
      },
    ]);

    expect(media.attachments[0]?.mediaKind).toBe(MediaKind.Sticker);
    expect(media.attachments[0]?.metadata.stickerId).toBe('369239263222822');
    expect(media.messageKind).toBe(MessageKind.Sticker);
  });

  it('keeps an unrecognised type rather than dropping it', () => {
    // A type we have never seen must still produce a row: the alternative is a
    // message that renders as empty and cannot be investigated later.
    const media = normalizeAttachments([
      { type: 'some_new_thing_meta_shipped', payload: { url: 'https://example.test/x' } },
    ]);

    expect(media.attachments).toHaveLength(1);
    expect(media.attachments[0]?.mediaKind).toBe(MediaKind.Document);
    expect(media.attachments[0]?.metadata.platformType).toBe('some_new_thing_meta_shipped');
    expect(media.messageKind).toBe(MessageKind.File);
  });

  it('is text when there is nothing attached', () => {
    expect(normalizeAttachments(undefined).messageKind).toBe(MessageKind.Text);
    expect(normalizeAttachments([]).attachments).toHaveLength(0);
  });

  it('numbers a carousel so its order survives', () => {
    const media = normalizeAttachments([
      { type: 'image', payload: { url: 'https://example.test/1' } },
      { type: 'image', payload: { url: 'https://example.test/2' } },
    ]);

    expect(media.attachments.map((a) => a.sortOrder)).toEqual([0, 1]);
  });

  it('survives a payload with no url at all', () => {
    // A malformed or url-less attachment must not fail the whole projection —
    // the rest of the message is still worth having.
    const media = normalizeAttachments([{ type: 'image' }]);

    expect(media.attachments[0]?.sourceUrl).toBeNull();
    expect(media.attachments[0]?.metadata.assetId).toBeUndefined();
  });

  it('does not mistake a lookalike host for a stable one', () => {
    expect(isStableMediaUrl('https://giphy.com.evil.test/x')).toBe(false);
    expect(isStableMediaUrl('https://media0.giphy.com/x')).toBe(true);
    expect(extractAssetId('not a url')).toBeNull();
  });

  it('reads what the backfill translated, exactly as if it were live', () => {
    /*
     * The read edge nests the link under image_data and names no type; the
     * worker translates that into the webhook shape before this sees it. Pinned
     * here because the whole point is that a message recovered by a resync ends
     * up identical to the same message delivered live — one set of rules, not
     * two.
     */
    const media = normalizeAttachments([
      { type: 'image', payload: { url: 'https://lookaside.fbsbx.com/x?asset_id=99&signature=s' } },
    ]);

    expect(media.attachments[0]?.mediaKind).toBe(MediaKind.Image);
    expect(media.attachments[0]?.metadata.assetId).toBe('99');
  });

  it('keeps a backfilled document as a file', () => {
    const media = normalizeAttachments([
      { type: 'file', payload: { url: 'https://x.test/a.pdf' } },
    ]);

    expect(media.attachments[0]?.mediaKind).toBe(MediaKind.Document);
    expect(media.messageKind).toBe(MessageKind.File);
  });
});
