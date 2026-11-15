import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { AppConfigService } from '@/config';
import { MediaAnalysisError, MediaFailure } from './gemini.errors';
import { parseMediaDescription } from './gemini.parse';

export interface MediaDescription {
  readonly summary: string | null;
  readonly transcript: string | null;
  readonly readable: boolean;
}

export interface AnalysisUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface AnalysisOutcome {
  readonly description: MediaDescription;
  readonly usage: AnalysisUsage;
  readonly model: string;
}

/**
 * The one place this service talks to Gemini.
 *
 * DELIBERATELY NARROW. It takes bytes and an instruction and returns a
 * description — it holds no prompt of its own, decides nothing about which
 * media is worth analysing, and knows nothing about attachments or threads.
 * The prompt and the model arrive from the platform settings a human edits, so
 * a bad description is a thing somebody can fix in a console rather than a
 * release.
 *
 * NOTHING CALLS IT UNLESS `GEMINI_ENABLED`. With the switch off this refuses
 * rather than silently doing nothing, because "the feature is off" and "the
 * feature ran and found nothing" must not look the same in the ledger.
 */
@Injectable()
export class GeminiClient {
  private client: GoogleGenAI | null = null;

  constructor(private readonly config: AppConfigService) {}

  get enabled(): boolean {
    return this.config.gemini.enabled && this.config.gemini.apiKey.length > 0;
  }

  /**
   * Built once, lazily.
   *
   * The key is passed EXPLICITLY rather than left to the SDK's environment
   * lookup. The SDK reads `GEMINI_API_KEY` from the process when constructed
   * with no argument, which would work — and would mean the key this service
   * actually used was whatever the environment happened to hold, not what its
   * own validated config says. One source for a secret.
   */
  private sdk(): GoogleGenAI {
    if (!this.enabled) {
      throw new MediaAnalysisError(
        MediaFailure.Disabled,
        'gemini is not configured in this environment',
        true,
      );
    }
    this.client ??= new GoogleGenAI({ apiKey: this.config.gemini.apiKey });
    return this.client;
  }

  /**
   * Describes a piece of media.
   *
   * THE BYTES GO INLINE. Gemini will not fetch a URL of ours, and Meta's CDN
   * would refuse it anyway — so the service downloads and sends what it got.
   * The caller is responsible for the size cap; by the time it reaches here
   * the payload is already known to be small enough to send.
   *
   * STORAGE IS OFF unless configuration says otherwise: a one-shot
   * description needs no conversation history, and leaving the media and its
   * description on Google's servers for 55 days is not something this call
   * should decide on its own.
   */
  async describeMedia(input: {
    readonly bytes: Buffer;
    readonly mimeType: string;
    readonly prompt: string;
    readonly model: string;
  }): Promise<AnalysisOutcome> {
    const ai = this.sdk();
    const { timeoutMs, storeInteractions } = this.config.gemini;

    let raw: unknown;
    try {
      raw = await this.withTimeout(
        ai.interactions.create({
          model: input.model,
          store: storeInteractions,
          input: [
            { type: 'text', text: input.prompt },
            {
              type: this.partTypeFor(input.mimeType),
              mime_type: input.mimeType,
              data: input.bytes.toString('base64'),
            },
          ],
        } as never),
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof MediaAnalysisError) throw error;
      /*
       * The message is kept but NOT the request. A model error can echo the
       * prompt back, and the prompt is wrapped around a customer's photo —
       * so what reaches a log or a ledger row is the failure, never the
       * payload that caused it.
       */
      throw new MediaAnalysisError(
        MediaFailure.ModelFailed,
        error instanceof Error ? error.message : 'the model call failed',
        false,
      );
    }

    return {
      description: parseMediaDescription(raw),
      usage: this.usageOf(raw),
      model: input.model,
    };
  }

  /**
   * Which part type a mime belongs to.
   *
   * Gemini types a part by kind rather than by mime alone, and sending an
   * audio clip as an image is rejected rather than coerced.
   */
  private partTypeFor(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'file';
  }

  private usageOf(raw: unknown): AnalysisUsage {
    const usage = (raw as { usage?: Record<string, unknown> } | null)?.usage;
    const read = (key: string): number | null => {
      const value = usage?.[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    return {
      inputTokens: read('total_input_tokens'),
      outputTokens: read('total_output_tokens'),
      totalTokens: read('total_tokens'),
    };
  }

  /**
   * A model call on a customer-facing path must give up before the request
   * does. The SDK's own timeout handling is not relied on here: an external
   * call with no bound of ours is an outage waiting for a slow day.
   */
  private async withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new MediaAnalysisError(
                  MediaFailure.ModelFailed,
                  `the model did not answer within ${ms}ms`,
                  false,
                ),
              ),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
