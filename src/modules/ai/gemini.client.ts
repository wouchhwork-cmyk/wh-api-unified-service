import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { AppConfigService } from '@/config';
import { withDeadline } from '@/shared/utils/deadline';
import { CHAT_MAX_OUTPUT_TOKENS, MEDIA_ANALYSIS_MAX_OUTPUT_TOKENS } from '@/shared/constants';
import { MediaAnalysisError, MediaFailure } from './gemini.errors';
import { ChatError, ChatFailure } from './chat.errors';
import { outputTextOf, parseMediaDescription } from './gemini.parse';
import {
  AiProvider,
  type AiProviderId,
  type ChatProvider,
  type ChatReply,
  type ChatRequest,
  type ChatTurn,
} from './ai.provider';

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
export class GeminiClient implements ChatProvider {
  readonly id: AiProviderId = AiProvider.Gemini;

  private client: GoogleGenAI | null = null;
  /** Which key built it — a console can replace the key between two calls. */
  private clientKey: string | null = null;

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
    /*
     * THE VERSION IS PASSED, NOT LEFT TO THE SDK. Its default is v1, which
     * refuses inline media — the first real image failed with
     * "The value 'image' is not supported for 'input[1].type' in v1". Sending
     * media IS this client's only job, so the version it needs is not an
     * optional extra.
     */
    return this.sdkWith(this.config.gemini.apiKey);
  }

  /**
   * The SDK for a given key, rebuilt when the key changes.
   *
   * The media path passes the environment's; chat passes whatever the
   * console holds, which may be an entirely different account.
   */
  private sdkWith(apiKey: string): GoogleGenAI {
    if (this.client === null || this.clientKey !== apiKey) {
      this.client = new GoogleGenAI({ apiKey, apiVersion: this.config.gemini.apiVersion });
      this.clientKey = apiKey;
    }
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
      raw = await withDeadline(
        ai.interactions.create({
          model: input.model,
          store: storeInteractions,
          /*
           * NOTHING IS REQUESTED THAT IS NOT NEEDED, and that is deliberate
           * rather than incidental:
           *
           *   - NO `tools`. Search grounding bills separately — $14 per 1,000
           *     grounded prompts past the free allowance — and describing a
           *     photo somebody just sent needs nothing from the web. A tool
           *     declaration is also tokens on every single request.
           *   - NO deep-research or agent model. Those exist for multi-step
           *     work; this is one question about one file.
           *   - NO stored interaction unless configured, so there is no
           *     conversation history accumulating against a one-shot call.
           *
           * The output is CAPPED. It is the expensive half — $2.50/M against
           * $0.30/M for input, and charged including thinking tokens — and an
           * instruction to be brief is advice a model may ignore, where this
           * is arithmetic it cannot.
           */
          generation_config: { max_output_tokens: MEDIA_ANALYSIS_MAX_OUTPUT_TOKENS },
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
        () =>
          new MediaAnalysisError(
            MediaFailure.ModelFailed,
            `the model did not answer within ${timeoutMs}ms`,
            false,
          ),
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
   * Holds a text conversation.
   *
   * THE HISTORY IS FLATTENED INTO ONE TEXT PART, which is not how OpenAI's
   * client does it and is deliberate. The interactions API types a part by
   * kind rather than by speaker, and inventing a role field we have not seen
   * accepted would fail at the only moment that matters — in front of a
   * customer. A labelled transcript is a shape every model reads, and the
   * labels are what keep "what they said" apart from "what we said".
   *
   * It costs the same tokens either way: the whole history is sent on every
   * turn regardless, because nothing is stored on their side.
   */
  async chat(request: ChatRequest): Promise<ChatReply> {
    const apiKey = request.apiKey?.trim() || this.config.gemini.apiKey;
    if (apiKey.length === 0) {
      throw new ChatError(ChatFailure.Disabled, 'gemini has no key to answer with', false);
    }
    const ai = this.sdkWith(apiKey);
    const { timeoutMs, storeInteractions, model } = this.config.gemini;
    const chosenModel = request.model?.trim() || model;

    let raw: unknown;
    try {
      raw = await withDeadline(
        ai.interactions.create({
          model: chosenModel,
          store: storeInteractions,
          /*
           * Gemini has no separate chat budget of its own: the cap is the
           * chat feature's, because what bounds a reply is how long a reply
           * should be, not whose model wrote it.
           */
          generation_config: {
            max_output_tokens: request.maxOutputTokens ?? CHAT_MAX_OUTPUT_TOKENS,
          },
          input: [{ type: 'text', text: this.transcriptOf(request) }],
        } as never),
        timeoutMs,
        () =>
          new ChatError(
            ChatFailure.Timeout,
            `the model did not answer within ${timeoutMs}ms`,
            true,
          ),
      );
    } catch (error) {
      if (error instanceof ChatError) throw error;
      /* The message, never the conversation that produced it. */
      throw new ChatError(
        ChatFailure.CallFailed,
        error instanceof Error ? error.message : 'the chat call failed',
        false,
      );
    }

    const text = outputTextOf(raw)?.trim() ?? '';
    if (text.length === 0) {
      throw new ChatError(ChatFailure.NoReply, 'the model returned no text', false);
    }

    const usage = this.usageOf(raw);
    return {
      text,
      usage: {
        ...usage,
        /* Gemini reports neither, and null is how a caller tells that apart
         * from a genuine zero when it adds up what a conversation cost. */
        cachedInputTokens: null,
        reasoningTokens: null,
      },
      truncated: (raw as { status?: unknown } | null)?.status === 'incomplete',
      model: chosenModel,
      provider: this.id,
    };
  }

  /**
   * The conversation as one labelled block.
   *
   * The instruction goes FIRST and the turns follow it, so the standing rules
   * are read before the text they are meant to govern — including the rule
   * that says text inside the conversation is content, never a command.
   */
  private transcriptOf(request: ChatRequest): string {
    const instructions = request.instructions?.trim() ?? '';
    const lines = request.turns.map(
      (turn: ChatTurn) => `${turn.role === 'user' ? 'Them' : 'You'}: ${turn.text.trim()}`,
    );
    return [instructions, instructions.length > 0 ? '' : null, ...lines, '', 'You:']
      .filter((line): line is string => line !== null)
      .join('\n');
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
}
