/**
 * Why a model call failed, in the only terms the caller needs: can it be
 * retried, and what gets written in the ledger's `failure_code`.
 *
 * PERMANENT MEANS A RETRY CANNOT HELP. An expired link cannot be un-expired
 * and an unsupported file will not become supported, so those go straight to
 * `unavailable` rather than burning the remaining attempts to arrive in the
 * same place. Everything else is assumed transient, because the costly mistake
 * is the other one: writing media off permanently because Google had a bad
 * minute.
 */
export class MediaAnalysisError extends Error {
  constructor(
    readonly failureCode: string,
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'MediaAnalysisError';
  }
}

export const MediaFailure = {
  /** The CDN link was already dead when we went to fetch it. */
  Expired: 'MEDIA_EXPIRED',
  /** The CDN refused us — a crawler block rather than a dead link. */
  Forbidden: 'MEDIA_FORBIDDEN',
  /** Nothing in our data points at a link for this media any more. */
  NoSource: 'MEDIA_NO_SOURCE',
  /** Fetched, but larger than we will send to a model. */
  TooLarge: 'MEDIA_TOO_LARGE',
  /** A kind the model cannot read, or one we decline to send. */
  Unsupported: 'MEDIA_UNSUPPORTED',
  /** The download did not finish in time. */
  DownloadTimeout: 'MEDIA_DOWNLOAD_TIMEOUT',
  /** The model call failed, or took too long. */
  ModelFailed: 'MEDIA_MODEL_FAILED',
  /** The model answered, but not in the shape the prompt asked for. */
  ModelUnparsable: 'MEDIA_MODEL_UNPARSABLE',
  /** The feature is configured off, or has no key. */
  Disabled: 'MEDIA_ANALYSIS_DISABLED',
} as const;
