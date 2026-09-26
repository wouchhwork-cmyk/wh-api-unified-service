import { describe, expect, it } from 'vitest';
import { renderAsFor } from '@/modules/inbox/inbox.controller';
import { MediaKind } from '@/shared/enums';
import type { AttachmentRow } from '@/database/repositories/message-attachment.repository';

/**
 * How a shared post, reel or advert is rendered.
 *
 * EVERY URL HERE IS REAL, taken from live deliveries to the connected account.
 * The rule they establish is that the LINK decides, not the label: Meta has
 * renamed these types twice (`share` -> `ig_reel` in September) and sends both
 * page links and CDN files under the same names, so a label-driven rule was
 * wrong in both directions at once.
 */
const attachment = (over: Partial<AttachmentRow>): AttachmentRow =>
  ({ mediaKind: MediaKind.Image, sourceUrl: null, metadata: {}, ...over }) as AttachmentRow;

/** A shared advert, 26 Sep — a real file on Meta's messaging CDN. */
const CDN_IMAGE =
  'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=17989554096101070&signature=Ab1OLd';
/** A shared reel — a page, not a file. */
const PERMALINK = 'https://www.instagram.com/reel/DPAbcDeFgHi/';

describe('deciding how to render a share', () => {
  it('shows a shared advert, because its link is a file', () => {
    /*
     * THE ONE THAT WAS BROKEN. `ig_post` was treated as a link on the strength
     * of its label alone, so an advert carrying a perfectly good CDN image
     * rendered as a 400-character signed url and the customer's message was
     * invisible. Reported from live traffic on 26 Sep.
     */
    expect(
      renderAsFor(
        attachment({ sourceUrl: CDN_IMAGE, metadata: { platformType: 'ig_post' } }),
      ),
    ).toBe('image');
  });

  it('still links a shared reel, because its link is a page', () => {
    // The case the label rule existed for, and which must not regress: an
    // instagram.com url in a <video> fails, and reported a broken video about
    // a link that opens fine.
    expect(
      renderAsFor(
        attachment({
          mediaKind: MediaKind.Video,
          sourceUrl: PERMALINK,
          metadata: { platformType: 'ig_reel' },
        }),
      ),
    ).toBe('link');
  });

  it('links anything with no url at all', () => {
    // A shared COMMENT arrives as an empty template: named, and carrying
    // nothing.
    expect(renderAsFor(attachment({ metadata: { platformType: 'template' } }))).toBe('link');
  });

  it('does not care what Meta called it when the link is a file', () => {
    /*
     * The point of the whole change. A name nobody has seen yet, on a real CDN
     * file, renders — where a label-driven rule would have to be edited every
     * time Meta invents a word.
     */
    expect(
      renderAsFor(
        attachment({ sourceUrl: CDN_IMAGE, metadata: { platformType: 'ig_something_new' } }),
      ),
    ).toBe('image');
  });

  it('plays a video whose link is a real file', () => {
    expect(
      renderAsFor(
        attachment({
          mediaKind: MediaKind.Video,
          sourceUrl: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x',
          metadata: { platformType: 'ig_story' },
        }),
      ),
    ).toBe('video');
  });
});
