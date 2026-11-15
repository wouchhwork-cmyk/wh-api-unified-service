/** schema.md §22 */
export enum MediaKind {
  Image = 'image',
  Video = 'video',
  Gif = 'gif',
  Audio = 'audio',
  Document = 'document',
  Sticker = 'sticker',
}

export enum AttachmentStatus {
  Active = 'active',
  Expired = 'expired',
  Downloading = 'downloading',
  DownloadFailed = 'download_failed',
}

/**
 * Where a piece of media is in the analysis pipeline.
 *
 * A LEDGER STATUS, not a description of the media. `done` means we asked the
 * model and wrote down what it said; it does NOT mean the media was readable —
 * an analysis that concluded "this image is blank" is a successful analysis.
 * `unavailable` is the one that means we never got to look.
 */
export enum MediaAnalysisStatus {
  /** Queued, never attempted. */
  Pending = 'pending',
  /** Claimed by a worker and in flight right now. */
  InFlight = 'in_flight',
  /** Asked and answered; `summary` holds the result. */
  Done = 'done',
  /** Attempted and failed, and may be retried while attempts remain. */
  Failed = 'failed',
  /**
   * Given up on permanently: attempts exhausted, or the media could not be
   * fetched at all because its link had already died. Distinct from `failed`
   * so the console can separate "still trying" from "never going to happen".
   */
  Unavailable = 'unavailable',
}
