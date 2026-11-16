import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import {
  MediaAnalysisRepository,
  type AnalysisResultRow,
  type AnalysisSeed,
  type ClaimedAnalysis,
} from '@/database/repositories/media-analysis.repository';
import { PlatformSettingRepository } from '@/database/repositories/platform-setting.repository';
import {
  MEDIA_ANALYSIS_ALLOWED_MIME_PREFIXES,
  MEDIA_ANALYSIS_RETRY_BASE_MS,
} from '@/shared/constants';
import { MediaKind } from '@/shared/enums';
import { GeminiClient } from './gemini.client';
import { MediaAnalysisError, MediaFailure } from './gemini.errors';
import { MediaDownloader } from './media-downloader';
import { ModelCallRepository } from '@/database/repositories/model-call.repository';
import { ModelCallPurpose, ModelCallStatus } from '@/shared/enums';
import { buildMediaAnalysisPrompt } from './prompts';

/** The platform setting that holds what we tell the model. */
export const MEDIA_ANALYSIS_SETTING_KEY = 'media_analysis';

export interface MediaAnalysisSettings {
  readonly model: string;
  readonly prompt: string;
  readonly version: number;
}

/**
 * Describes media before its link dies, and keeps the description.
 *
 * THE WHOLE FEATURE IN ONE SENTENCE: Meta's media links expire and cannot be
 * re-issued beyond the newest 20 messages of a thread, so a photo a customer
 * sent in September is already unrecoverable — but a few sentences saying what
 * it showed would still be here, and would answer the question anybody
 * actually asks about it later.
 */
@Injectable()
export class MediaAnalysisService {
  constructor(
    private readonly analyses: MediaAnalysisRepository,
    private readonly settings: PlatformSettingRepository,
    private readonly gemini: GeminiClient,
    private readonly downloader: MediaDownloader,
    private readonly calls: ModelCallRepository,
    private readonly config: AppConfigService,
    @InjectPinoLogger(MediaAnalysisService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Queues media that has not been described before.
   *
   * Called from the ingest path, where the link is at its freshest — which is
   * the only moment the bytes are reliably reachable. Queueing is cheap and
   * idempotent: the unique key means a redelivered webhook or a second
   * attachment carrying the same asset adds nothing.
   *
   * NEVER THROWS INTO INGEST. A webhook that fails because an optional
   * description could not be queued would lose the message itself, which is
   * the thing that actually matters.
   */
  async queue(enterpriseId: number, seeds: readonly AnalysisSeed[]): Promise<number> {
    const worth = seeds.filter((seed) => this.isWorthAnalysing(seed.mediaKind, seed.mimeType));
    if (worth.length === 0) return 0;

    try {
      const queued = await this.analyses.enqueueMany(enterpriseId, worth);
      if (queued > 0) {
        this.logger.debug(
          { enterpriseId, queued, seen: worth.length },
          'queued media for analysis',
        );
      }
      return queued;
    } catch (error) {
      this.logger.warn(
        { err: error, enterpriseId, seen: worth.length },
        'could not queue media for analysis; the message is unaffected',
      );
      return 0;
    }
  }

  /**
   * One media, described and settled.
   *
   * Returns nothing: the outcome is the ledger row, and every path through
   * here writes one. A thrown error would leave the row leased with nobody
   * holding it, which is what the lease reaper exists to clean up rather than
   * something to rely on.
   */
  async analyse(claimed: ClaimedAnalysis, leaseOwner: string): Promise<void> {
    try {
      if (!this.gemini.enabled) {
        throw new MediaAnalysisError(
          MediaFailure.Disabled,
          'media analysis is switched off in this environment',
          true,
        );
      }

      const source = await this.analyses.findLiveSource(claimed.enterpriseId, claimed.mediaKey);
      if (!source) {
        /*
         * PERMANENT. Nothing in our data points at a link for this media any
         * more — the attachment was deleted, or never had one. Retrying reads
         * the same absence.
         */
        throw new MediaAnalysisError(
          MediaFailure.NoSource,
          'no attachment holds a link for this media',
          true,
        );
      }

      const media = await this.downloader.fetch(source.sourceUrl, claimed.mimeType);
      if (!this.isAllowedMime(media.mimeType)) {
        throw new MediaAnalysisError(
          MediaFailure.Unsupported,
          `nothing here reads ${media.mimeType}`,
          true,
        );
      }

      const instruction = await this.currentSettings();
      /* Ours rather than the provider's: neither reports how long it took. */
      const startedAt = Date.now();
      const outcome = await this.gemini.describeMedia({
        bytes: media.bytes,
        mimeType: media.mimeType,
        /*
         * THE SAVED PROMPT IS NOW ONE SECTION OF THE INSTRUCTION, not the
         * whole of it. What staff write says what this business cares about
         * seeing; the shape of the answer, and the rule that writing inside
         * the media is not an instruction, are built around it here — where
         * they cannot be edited out of the box that also has to be readable
         * by a person who has never heard of JSON.
         */
        prompt: buildMediaAnalysisPrompt(instruction.prompt),
        model: instruction.model,
      });

      /*
       * THE CALL LEFT THIS SERVICE, so it has a record of its own.
       *
       * The ledger row below says what the media turned out to be; this says
       * what asking cost. They are not the same fact, and the ledger row is
       * updated in place on a retry — so without this, the tokens a failed
       * first attempt spent would simply disappear from the record.
       */
      await this.calls.record({
        enterpriseId: claimed.enterpriseId,
        provider: 'gemini',
        model: outcome.model,
        purpose: ModelCallPurpose.MediaDescription,
        status: ModelCallStatus.Ok,
        mediaKey: claimed.mediaKey,
        promptVersion: instruction.version,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        totalTokens: outcome.usage.totalTokens,
        durationMs: Date.now() - startedAt,
      });

      await this.analyses.markDone(claimed.id, leaseOwner, {
        /*
         * An unreadable media still produces a row. `readable: false` means
         * the model looked and could not make it out, which is a real answer
         * worth keeping — it stops anybody re-queueing the same blank image
         * and tells a reader the media was broken rather than undescribed.
         */
        summary: outcome.description.summary,
        transcript: outcome.description.transcript,
        language: outcome.description.language,
        model: outcome.model,
        promptVersion: instruction.version,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        totalTokens: outcome.usage.totalTokens,
      });

      this.logger.info(
        {
          enterpriseId: claimed.enterpriseId,
          mediaKey: claimed.mediaKey,
          mediaKind: claimed.mediaKind,
          model: outcome.model,
          totalTokens: outcome.usage.totalTokens,
          readable: outcome.description.readable,
        },
        'described a piece of media',
      );
    } catch (error) {
      await this.settleFailure(claimed, leaseOwner, error);
    }
  }

  /**
   * What the model is told, and which model is told it.
   *
   * FROM THE DATABASE, falling back to configuration. Staff edit the prompt in
   * the console, so the stored row is the authority — but a service that
   * cannot read its settings should still work rather than stop, and the
   * environment's model is a reasonable last word.
   */
  async currentSettings(): Promise<MediaAnalysisSettings> {
    const stored = await this.settings.find(MEDIA_ANALYSIS_SETTING_KEY);
    const model = typeof stored?.value.model === 'string' ? stored.value.model.trim() : '';
    const prompt = typeof stored?.value.prompt === 'string' ? stored.value.prompt.trim() : '';

    return {
      model: model.length > 0 ? model : this.config.gemini.model,
      prompt: prompt.length > 0 ? prompt : FALLBACK_PROMPT,
      version: stored?.version ?? 0,
    };
  }

  /** The descriptions for a set of media, for rendering a thread. */
  async resultsFor(enterpriseId: number, keys: readonly string[]): Promise<AnalysisResultRow[]> {
    return this.analyses.findByKeys(enterpriseId, keys);
  }

  /**
   * Worth sending to a model at all.
   *
   * A document carries no picture to describe and a model reading one buys
   * nothing a filename does not already say. The mime check is the real gate;
   * the kind is what we knew at ingest, which is sometimes wrong.
   */
  private isWorthAnalysing(kind: MediaKind, mimeType: string | null): boolean {
    if (kind === MediaKind.Document) return false;
    if (!mimeType) return true;
    return this.isAllowedMime(mimeType);
  }

  private isAllowedMime(mimeType: string): boolean {
    return MEDIA_ANALYSIS_ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
  }

  /**
   * Writes why it did not work, and whether it is worth trying again.
   *
   * THE REASON IS REDACTED TO ITS CODE AND MESSAGE. A model or CDN error can
   * quote the request back, and the request wraps a customer's photo and a
   * signed URL — neither belongs in a ledger row that staff will read.
   */
  private async settleFailure(
    claimed: ClaimedAnalysis,
    leaseOwner: string,
    error: unknown,
  ): Promise<void> {
    const known = error instanceof MediaAnalysisError;
    const failureCode = known ? error.failureCode : MediaFailure.ModelFailed;
    const permanent = known ? error.permanent : false;
    const reason = error instanceof Error ? error.message.slice(0, 500) : 'unknown failure';

    const backoffMs = MEDIA_ANALYSIS_RETRY_BASE_MS * Math.max(1, claimed.attemptCount);

    /*
     * ONLY WHEN THE CALL ACTUALLY WENT OUT.
     *
     * Most failures here never reach a model: a dead CDN link, a file too
     * large to send, a kind nothing reads, the feature switched off. Filing
     * those as model calls would put failures in the record against a
     * provider that was never asked anything, and the first person reading
     * it would conclude the model was broken.
     */
    if (failureCode === MediaFailure.ModelFailed || failureCode === MediaFailure.ModelUnparsable) {
      await this.calls.record({
        enterpriseId: claimed.enterpriseId,
        provider: 'gemini',
        model: (await this.currentSettings()).model,
        purpose: ModelCallPurpose.MediaDescription,
        status: ModelCallStatus.Failed,
        mediaKey: claimed.mediaKey,
        failureCode,
        /* Redacted at the throw site: a model error can quote the prompt
         * back, and the prompt is wrapped around a customer's photo. */
        failureReason: reason,
      });
    }

    await this.analyses.markFailed(claimed.id, leaseOwner, {
      failureCode,
      failureReason: reason,
      permanent,
      backoffMs,
    });

    this.logger[permanent ? 'info' : 'warn'](
      {
        enterpriseId: claimed.enterpriseId,
        mediaKey: claimed.mediaKey,
        failureCode,
        permanent,
        attempt: claimed.attemptCount,
      },
      permanent ? 'media cannot be described' : 'media description failed; will retry',
    );
  }
}

/**
 * Used only when the settings row is missing entirely — a database seeded
 * before this feature, or one somebody has deleted a row from. The real
 * instruction lives in `platform_settings` and is editable by staff.
 */
/**
 * What a business would want noticed, for one that has never said.
 *
 * SHORTER THAN IT WAS, because most of what used to be here was contract —
 * the JSON shape, and the rule about instructions hidden in the media — and
 * both now live in code where nobody can delete them by tidying up a text
 * box. What is left is the only part that was ever a preference.
 */
const FALLBACK_PROMPT = [
  'Note anything this business would need in order to act on it: products and their condition,',
  'damage, labels, prices, order or booking references, dates, and the content of any screenshot.',
].join('\n');
