import { Injectable } from '@nestjs/common';
import { MEDIA_ANALYSIS_MAX_BYTES, MEDIA_DOWNLOAD_TIMEOUT_MS } from '@/shared/constants';
import { MediaAnalysisError, MediaFailure } from './gemini.errors';

export interface DownloadedMedia {
  readonly bytes: Buffer;
  readonly mimeType: string;
}

/**
 * Fetches the bytes behind a platform media link.
 *
 * THE LINK IS ASSUMED TO BE DYING. Every failure here is classified as
 * permanent or not on exactly that basis: a 404 means the signature has
 * already expired and no retry will bring it back, while a timeout or a 503
 * means Meta had a bad moment and the link may still be good. Getting that
 * backwards in the permanent direction throws media away for ever, so the
 * default for anything unrecognised is "try again".
 */
@Injectable()
export class MediaDownloader {
  async fetch(url: string, declaredMime: string | null): Promise<DownloadedMedia> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);

    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch {
      /*
       * The thrown error is deliberately not kept. `fetch` rejects with a
       * message that can quote the signed URL, and that URL is a credential —
       * what matters is whether we gave up or the network did, which the
       * abort signal already says.
       */
      const aborted = controller.signal.aborted;
      throw new MediaAnalysisError(
        aborted ? MediaFailure.DownloadTimeout : MediaFailure.ModelFailed,
        aborted ? 'the media did not download in time' : 'the media could not be fetched',
        false,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 403) {
      throw new MediaAnalysisError(
        MediaFailure.Forbidden,
        'the platform refused the media request',
        false,
      );
    }
    if (response.status === 404 || response.status === 410) {
      /*
       * PERMANENT, and it is the common case. A signed link that has expired
       * answers 404; it cannot be un-expired, and the only thing that could
       * help is a fresh link, which is the refresh path's job rather than a
       * retry of this one.
       */
      throw new MediaAnalysisError(MediaFailure.Expired, 'the media link has expired', true);
    }
    if (!response.ok) {
      throw new MediaAnalysisError(
        MediaFailure.ModelFailed,
        `the platform answered ${response.status}`,
        false,
      );
    }

    /*
     * THE CAP IS CHECKED BEFORE READING WHERE POSSIBLE. `content-length` is
     * advisory — it can be absent or wrong — so the body is bounded again
     * after reading. Trusting the header alone would let a server with no
     * header hand us an unbounded file.
     */
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MEDIA_ANALYSIS_MAX_BYTES) {
      throw new MediaAnalysisError(
        MediaFailure.TooLarge,
        `the media is ${declaredLength} bytes, over the analysis limit`,
        true,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MEDIA_ANALYSIS_MAX_BYTES) {
      throw new MediaAnalysisError(
        MediaFailure.TooLarge,
        `the media is ${bytes.byteLength} bytes, over the analysis limit`,
        true,
      );
    }
    if (bytes.byteLength === 0) {
      throw new MediaAnalysisError(MediaFailure.Expired, 'the media was empty', true);
    }

    /*
     * WHAT THE SERVER SAYS IT IS beats what we recorded. Meta frequently
     * stores no mime at ingest and labels a story mention as an image when it
     * is a video, and the model rejects a part whose declared type is wrong.
     */
    const served = response.headers.get('content-type')?.split(';')[0]?.trim();
    const mimeType = served && served.length > 0 ? served : (declaredMime ?? '');
    if (!mimeType) {
      throw new MediaAnalysisError(
        MediaFailure.Unsupported,
        'the media has no usable content type',
        true,
      );
    }

    return { bytes, mimeType };
  }
}
