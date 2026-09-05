import { MediaKind, MessageKind } from '@/shared/enums';

/**
 * Meta's attachment shape on a messaging webhook, and what we keep from it.
 *
 * WHY THIS EXISTS: the projector used to read `attachments.length` and nothing
 * else, so a story mention — whose entire content IS the attachment — was stored
 * as an empty message. The URL survived only in the raw ledger payload.
 *
 * WHAT WE MAY KEEP: Meta's terms are explicit that the media itself must not be
 * stored or cached on our servers; the CDN link may be. So this normalizes to a
 * link plus the facts around it, and downloading is deliberately not done here.
 * The link dies with the story — 24 hours — after which the UI shows a
 * placeholder.
 */
export interface PlatformAttachment {
  readonly type?: string;
  readonly payload?: {
    readonly url?: string;
    readonly sticker_id?: number | string;
    readonly title?: string;
    readonly reel_video_id?: string;
  };
}

export interface NormalizedAttachment {
  readonly mediaKind: MediaKind;
  readonly sourceUrl: string | null;
  readonly sortOrder: number;
  /** Platform facts worth keeping that have no column of their own. */
  readonly metadata: Record<string, unknown>;
}

export interface NormalizedMedia {
  readonly attachments: readonly NormalizedAttachment[];
  readonly messageKind: MessageKind;
  /** Someone tagged the business in their story, rather than sending media. */
  readonly isStoryMention: boolean;
}

export const STORY_MENTION_TYPE = 'story_mention';

/**
 * Meta's attachment type to ours.
 *
 * A story mention is an image as far as storage is concerned; that it is a story
 * is carried by the message kind and the attachment metadata, not by pretending
 * we have a media kind for it.
 */
const MEDIA_KIND_BY_TYPE: Readonly<Record<string, MediaKind>> = {
  image: MediaKind.Image,
  [STORY_MENTION_TYPE]: MediaKind.Image,
  video: MediaKind.Video,
  ig_reel: MediaKind.Video,
  reel: MediaKind.Video,
  audio: MediaKind.Audio,
  voice: MediaKind.Audio,
  file: MediaKind.Document,
  share: MediaKind.Document,
  location: MediaKind.Document,
  fallback: MediaKind.Document,
  template: MediaKind.Document,
};

const MESSAGE_KIND_BY_MEDIA: Readonly<Record<MediaKind, MessageKind>> = {
  [MediaKind.Image]: MessageKind.Image,
  [MediaKind.Gif]: MessageKind.Image,
  [MediaKind.Video]: MessageKind.Video,
  [MediaKind.Audio]: MessageKind.Audio,
  [MediaKind.Sticker]: MessageKind.Sticker,
  [MediaKind.Document]: MessageKind.File,
};

/**
 * The story's asset id, lifted out of the CDN link's query string.
 *
 * Worth keeping precisely BECAUSE the link expires: the signature and the host
 * are useless in a day, but the asset id still identifies which story this was,
 * so a later feature can group, deduplicate or re-resolve it. It is the one
 * durable identifier in the whole attachment.
 */
export function extractAssetId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get('asset_id');
  } catch {
    // A malformed URL is not worth failing a projection over.
    return null;
  }
}

/*
 * TWO SEPARATE QUESTIONS, deliberately answered by two predicates.
 *
 * They were one — "is this a known GIF host" decided both whether to render an
 * animation and whether to warn that the link might vanish — and that made a
 * host we do not recognise wrong twice over: its GIF rendered as a still, AND a
 * permanent third-party link was advertised as expiring.
 */

/**
 * Links that STOP WORKING, which is a thing we actually know rather than guess.
 *
 * Meta signs its media URLs and they die with the content they point at — about
 * 24 hours for a story. Every host below is Meta's; anything else belongs to
 * somebody whose links we have no reason to think are temporary, so an
 * unrecognised host is treated as permanent. That is the honest default: we can
 * name what expires, and claiming a stranger's link is about to vanish would be
 * an invention.
 */
const EXPIRING_MEDIA_HOSTS = ['fbsbx.com', 'fbcdn.net', 'cdninstagram.com'];

/** Hosts whose `image` really means an animation. */
const GIF_HOSTS = ['giphy.com', 'tenor.com'];

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Matches a host or any subdomain of it, and NOTHING ELSE.
 *
 * The dot matters: a bare `endsWith('giphy.com')` also matches
 * `giphy.com.evil.test`, which is how an attacker gets their link treated as
 * trusted.
 */
function hostMatches(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isExpiringMediaUrl(url: string | null | undefined): boolean {
  const host = hostOf(url);
  return host !== null && hostMatches(host, EXPIRING_MEDIA_HOSTS);
}

/** Kept as the inverse, since that is what the row and the API talk about. */
export function isStableMediaUrl(url: string | null | undefined): boolean {
  return hostOf(url) !== null && !isExpiringMediaUrl(url);
}

/**
 * Whether an `image` is really an animation.
 *
 * Meta gives no type for this at all, so it takes both signals: a host we know
 * serves GIFs, or a path that ends in .gif — which catches a source we have
 * never seen, the case a fixed host list can only ever get wrong.
 */
export function isAnimatedImageUrl(url: string | null | undefined): boolean {
  const host = hostOf(url);
  if (host === null) return false;
  if (hostMatches(host, GIF_HOSTS)) return true;

  try {
    return new URL(url as string).pathname.toLowerCase().endsWith('.gif');
  } catch {
    return false;
  }
}

/** An unrecognised type is kept as a document rather than dropped. */
function toMediaKind(attachment: PlatformAttachment): MediaKind {
  // Messenger sends a sticker as an image carrying a sticker_id, so the id is
  // what distinguishes the two, not the type.
  if (attachment.payload?.sticker_id !== undefined) return MediaKind.Sticker;

  const type = attachment.type?.trim().toLowerCase() ?? '';
  const mediaKind = MEDIA_KIND_BY_TYPE[type] ?? MediaKind.Document;

  /*
   * Meta labels a GIF as an `image`. MediaKind.Gif existed and nothing ever
   * produced it, so every GIF in the inbox was indistinguishable from a photo —
   * and a client that renders one as a still picture loses the whole point of
   * it. The Giphy host is the only signal Meta gives.
   */
  if (mediaKind === MediaKind.Image && isAnimatedImageUrl(attachment.payload?.url)) {
    return MediaKind.Gif;
  }

  return mediaKind;
}

export function normalizeAttachments(
  attachments: readonly PlatformAttachment[] | undefined,
): NormalizedMedia {
  if (!attachments?.length) {
    return { attachments: [], messageKind: MessageKind.Text, isStoryMention: false };
  }

  const isStoryMention = attachments.some(
    (attachment) => attachment.type?.trim().toLowerCase() === STORY_MENTION_TYPE,
  );

  const normalized = attachments.map((attachment, index): NormalizedAttachment => {
    const type = attachment.type?.trim().toLowerCase() ?? null;
    const sourceUrl = attachment.payload?.url ?? null;
    const assetId = extractAssetId(sourceUrl);

    const metadata: Record<string, unknown> = {};
    // The platform's own word for it. Ours is a bucket — `share` and `file` both
    // land on `document` — and the distinction is the sort of thing a later
    // feature needs and cannot recover once thrown away.
    if (type) metadata.platformType = type;
    if (assetId) metadata.assetId = assetId;
    if (attachment.payload?.sticker_id !== undefined) {
      metadata.stickerId = String(attachment.payload.sticker_id);
    }
    if (attachment.payload?.title) metadata.title = attachment.payload.title;
    // Whether this link outlives the message. The UI needs it to decide between
    // "this image is gone" and "this image failed to load".
    if (sourceUrl) metadata.stableUrl = isStableMediaUrl(sourceUrl);
    if (attachment.payload?.reel_video_id) metadata.reelVideoId = attachment.payload.reel_video_id;

    return { mediaKind: toMediaKind(attachment), sourceUrl, sortOrder: index, metadata };
  });

  /*
   * A story mention is its own kind of thing — not "an image someone sent" — and
   * the inbox has to be able to say so, because the reply goes to a story that
   * may already be gone.
   */
  if (isStoryMention) {
    return { attachments: normalized, messageKind: MessageKind.StoryReply, isStoryMention };
  }

  // The first attachment names the message. A mixed carousel is rare and the
  // attachment rows carry the truth for anything that cares.
  const first = normalized[0];
  const messageKind = first ? MESSAGE_KIND_BY_MEDIA[first.mediaKind] : MessageKind.Text;

  return { attachments: normalized, messageKind, isStoryMention };
}
