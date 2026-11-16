import { Injectable } from '@nestjs/common';
import { AppConfigService } from '@/config';
import { PlatformSettingRepository } from '@/database/repositories/platform-setting.repository';
import {
  AI_PROVIDER_IDS,
  AiProvider,
  isAiProviderId,
  type AiProviderId,
  type ChatReply,
  type ChatTurn,
} from './ai.provider';
import { ModelRouter } from './model-router.service';
import { buildChatReplyPrompt, readChatReply } from './prompts';
import { TokenCipherService } from '@/shared/crypto';
import { ModelCallRepository } from '@/database/repositories/model-call.repository';
import { ModelCallPurpose, ModelCallStatus } from '@/shared/enums';
import { ChatError } from './chat.errors';

/** The platform setting that holds what we tell the model, and which model. */
export const CHAT_SETTING_KEY = 'chat';

export interface ChatSettings {
  readonly provider: AiProviderId;
  /** The model for the chosen provider. A model id belongs to one vendor. */
  /** The platform's kill switch for automatic replies. Off unless stored true. */
  readonly autoReply: boolean;
  /** Sent to the customer when a reply cannot be produced. Empty = say nothing. */
  readonly fallbackMessage: string;
  /** Sent while media is still being described. Empty = wait silently. */
  readonly mediaHoldMessage: string;
  readonly model: string;
  readonly prompt: string;
  readonly version: number;
}

/**
 * What a caller has to say about a reply it is asking for.
 *
 * THE TENANT AND THE REASON ARE NOT OPTIONAL. A record of a paid call that
 * cannot say which business it was for, or whether a person asked for it,
 * answers none of the questions a bill raises.
 */
export interface ChatReplyOptions {
  readonly enterpriseId: number;
  readonly purpose: ModelCallPurpose;
  /** The assembled facts for this conversation, already tagged. */
  readonly context?: string;
  /** The inbound message being answered, when there is one. */
  readonly messageId?: number | null;
}

export interface ChatAnswer extends ChatReply {
  /** Which saved instruction produced this, so an odd reply is traceable. */
  readonly promptVersion: number;
  /** The language the model says it answered in. */
  readonly language: string | null;
  /** What it understood the person to want, in a few words. */
  readonly intent: string | null;
  /** Why a colleague is needed, when the model said one is. */
  readonly handoff: string | null;
  /** The model's own decision that nothing needs saying. */
  readonly silent: boolean;
  /** Whether it answered in the shape it was asked for. */
  readonly structured: boolean;
}

/**
 * The standing instruction, for a console nobody has opened yet and a
 * database that cannot be read.
 *
 * Deliberately plain: who the model is talking to and what it must not do.
 * The last two lines are the ones that are not optional — a chat carries text
 * other people wrote, and text that arrives inside a conversation is content
 * to answer, never a command to obey.
 */
/**
 * The apology of last resort, for a database that cannot be read.
 *
 * Deliberately vague about the cause. A customer does not need to hear that
 * a model call failed, and "we are having technical difficulties" invites a
 * question nobody here can answer either.
 */
const FALLBACK_APOLOGY =
  "Sorry, I have to step away for something urgent — I'll get back to you shortly.";

/** Said while a photo is still being looked at, when the row cannot be read. */
const MEDIA_HOLD = 'Let me take a look at that…';

/**
 * How a business sounds, for one that has not said.
 *
 * MUCH SHORTER THAN IT WAS. Everything that used to be here about not
 * inventing facts and not obeying text found inside a conversation has moved
 * into the system frame, where a console cannot edit it away — and where it
 * belongs, because those are not preferences. What is left is voice, which
 * is the only part a business should have to think about.
 */
const FALLBACK_PROMPT = [
  'Be warm and direct. Help if you can, and say plainly when something is not something you can do.',
].join('\n');

/**
 * Holds a text conversation, with everything about it editable without a
 * deploy: the instruction, the model, and which provider answers.
 *
 * THE SPLIT IS THE POINT. The clients know how to talk to a vendor and hold
 * no prompt; the router knows which client; this knows what we say and who we
 * say it to, all three read from a row staff can edit. The first hundred real
 * conversations teach you more about an instruction than any amount of
 * writing it carefully beforehand — and the same goes for which model is
 * worth paying for.
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly settings: PlatformSettingRepository,
    private readonly router: ModelRouter,
    private readonly config: AppConfigService,
    private readonly cipher: TokenCipherService,
    private readonly calls: ModelCallRepository,
  ) {}

  /**
   * Which providers can actually answer — from the console's keys as well as
   * the environment's.
   *
   * ASYNC NOW, because a stored key is a row rather than a constant. The
   * caller that reports "no provider is configured" has to read the same
   * places a call would, or it reports on the wrong one.
   */
  async availableProviders(): Promise<readonly AiProviderId[]> {
    const keys = await this.storedKeys();
    return AI_PROVIDER_IDS.filter((provider) => this.hasKey(provider, keys));
  }

  async enabledFor(provider: AiProviderId): Promise<boolean> {
    return this.hasKey(provider, await this.storedKeys());
  }

  /**
   * Where each provider's key comes from, for a console to report WITHOUT
   * ever holding the key itself.
   *
   * The last four characters of a console-held key are included, and nothing
   * more: enough to tell two keys apart when somebody is wondering which one
   * is in there, useless to anybody who obtains it.
   */
  async keyStatus(): Promise<
    Record<AiProviderId, { source: 'console' | 'environment' | 'none'; hint: string | null }>
  > {
    const keys = await this.storedKeys();
    const status = {} as Record<
      AiProviderId,
      { source: 'console' | 'environment' | 'none'; hint: string | null }
    >;
    for (const provider of AI_PROVIDER_IDS) {
      const stored = keys[provider];
      if (stored) {
        status[provider] = { source: 'console', hint: stored.slice(-4) };
      } else if (this.environmentKey(provider).length > 0) {
        status[provider] = { source: 'environment', hint: null };
      } else {
        status[provider] = { source: 'none', hint: null };
      }
    }
    return status;
  }

  /**
   * The stored keys, decrypted.
   *
   * A KEY THAT WILL NOT DECRYPT IS TREATED AS ABSENT rather than raised on.
   * It means a lost or rotated master key, and the useful behaviour then is
   * to fall back to the environment and let the console show that nothing is
   * stored — not to take the assistant down for every business at once.
   */
  private async storedKeys(): Promise<Partial<Record<AiProviderId, string>>> {
    const stored = await this.settings.find(CHAT_SETTING_KEY);
    const envelopes = (stored?.value.apiKeys ?? {}) as Record<string, unknown>;
    const keys: Partial<Record<AiProviderId, string>> = {};
    for (const provider of AI_PROVIDER_IDS) {
      const envelope = envelopes[provider];
      if (typeof envelope !== 'string' || envelope.length === 0) continue;
      try {
        const plain = this.cipher.decrypt(envelope).trim();
        if (plain.length > 0) keys[provider] = plain;
      } catch {
        /* Unreadable: the environment answers instead. */
      }
    }
    return keys;
  }

  private hasKey(provider: AiProviderId, keys: Partial<Record<AiProviderId, string>>): boolean {
    return (keys[provider] ?? '').length > 0 || this.environmentKey(provider).length > 0;
  }

  private environmentKey(provider: AiProviderId): string {
    return provider === AiProvider.Gemini ? this.config.gemini.apiKey : this.config.openai.apiKey;
  }

  /**
   * What the model is told, which model is told it, and by whom.
   *
   * FROM THE DATABASE, falling back to configuration. The stored row is the
   * authority because staff edit it — but a service that cannot read its
   * settings should still answer rather than stop, and the environment is a
   * reasonable last word.
   */
  async currentSettings(): Promise<ChatSettings> {
    const stored = await this.settings.find(CHAT_SETTING_KEY);
    const models = (stored?.value.models ?? {}) as Record<string, unknown>;
    const prompt = typeof stored?.value.prompt === 'string' ? stored.value.prompt.trim() : '';
    const provider = stored?.value.provider;

    /*
     * A stored provider that is not one we have is IGNORED rather than
     * trusted: the row is edited by hand, and a typo there should not reach
     * the router as a provider nobody implements.
     */
    const chosen = isAiProviderId(provider) ? provider : AiProvider.OpenAi;

    return {
      provider: chosen,
      /*
       * ANYTHING BUT A STORED `true` IS OFF. A missing field, a string, a
       * row that has never been written — none of them is somebody deciding
       * to let an assistant answer customers, and only that decision counts.
       */
      autoReply: stored?.value.autoReply === true,
      fallbackMessage:
        typeof stored?.value.fallbackMessage === 'string'
          ? stored.value.fallbackMessage.trim()
          : FALLBACK_APOLOGY,
      mediaHoldMessage:
        typeof stored?.value.mediaHoldMessage === 'string'
          ? stored.value.mediaHoldMessage.trim()
          : MEDIA_HOLD,
      /*
       * The model falls back PER PROVIDER, because a model id means nothing
       * outside the provider that serves it — "gpt-6-luna" is not a thing
       * Google will answer to.
       */
      model: this.modelFrom(chosen, models),
      prompt: prompt.length > 0 ? prompt : FALLBACK_PROMPT,
      version: stored?.version ?? 0,
    };
  }

  /**
   * Answers the last turn, under whatever is saved right now.
   *
   * The settings are read PER CALL rather than cached, because the whole
   * reason they live in a row is that somebody can change them and see the
   * change. It is one indexed read against a call that costs money and
   * hundreds of milliseconds.
   *
   * WHAT THE CALLER PASSES IS FACTS, NOT INSTRUCTIONS. It used to be prose
   * appended to the prompt, which meant any caller could bury the rules
   * about inventing facts under a paragraph of its own — by accident, on the
   * day somebody added one more thing to say. Now the caller fills the
   * `<context>` section and nothing else: the role, the rules and the output
   * contract are assembled here, around both it and the console's prompt.
   */
  async reply(turns: readonly ChatTurn[], options: ChatReplyOptions): Promise<ChatAnswer> {
    const settings = await this.currentSettings();
    const apiKey = (await this.storedKeys())[settings.provider];

    /*
     * MEASURED HERE, because nothing else can. Neither provider reports how
     * long it took, and "the assistant has got slow" is a different problem
     * from "the assistant is failing" — a distinction nobody can make from
     * the outcome alone until a customer complains.
     */
    const startedAt = Date.now();

    /*
     * THE RECORD IS OPENED BEFORE THE CALL. If this process dies while the
     * model is thinking, the row survives saying one went out — which is the
     * fact worth having, and the one that recording afterwards loses.
     */
    const callId = await this.calls.begin({
      enterpriseId: options.enterpriseId,
      provider: settings.provider,
      model: settings.model,
      purpose: options.purpose,
      messageId: options.messageId ?? null,
      promptVersion: settings.version,
    });

    let reply;
    try {
      reply = await this.router.chat(settings.provider, {
        turns,
        /* Only when the console holds one; otherwise the client uses its own
         * environment key, which is the ordinary case. */
        ...(apiKey ? { apiKey } : {}),
        instructions: buildChatReplyPrompt({
          businessPrompt: settings.prompt,
          context: options.context ?? '',
        }),
        model: settings.model,
      });
    } catch (error) {
      /*
       * A CALL THAT FAILED STILL LEFT THIS SERVICE. It may have been billed,
       * it certainly took time, and it is the one somebody is looking for
       * when they ask why a customer got an apology. Recorded before the
       * error is re-thrown, so the caller's own handling is unchanged.
       */
      await this.calls.settle(callId, {
        status: ModelCallStatus.Failed,
        durationMs: Date.now() - startedAt,
        failureCode: error instanceof ChatError ? error.failureCode : 'CHAT_CALL_FAILED',
        /* The message, never the request: a model error can quote the prompt
         * back, and the prompt is wrapped around somebody's conversation. */
        failureReason: error instanceof Error ? error.message : null,
      });
      throw error;
    }

    const durationMs = Date.now() - startedAt;

    /*
     * The envelope is opened HERE rather than in a client, because it is a
     * property of what we asked for rather than of who answered: both
     * providers are asked for the same object and both are read the same
     * way. A client that parsed it would have to be taught the shape twice.
     */
    const fields = readChatReply(reply.text);

    await this.calls.settle(
      callId,
      {
        status: ModelCallStatus.Ok,
        inputTokens: reply.usage.inputTokens,
        outputTokens: reply.usage.outputTokens,
        totalTokens: reply.usage.totalTokens,
        cachedInputTokens: reply.usage.cachedInputTokens,
        reasoningTokens: reply.usage.reasoningTokens,
        durationMs,
        truncated: reply.truncated,
      },
      /* What actually answered, which a router is free to differ on. */
      reply.model,
    );

    return {
      ...reply,
      text: fields.text,
      language: fields.language,
      intent: fields.intent,
      handoff: fields.handoff,
      silent: fields.silent,
      structured: fields.structured,
      promptVersion: settings.version,
    };
  }

  /**
   * The model for a provider, from its own slot.
   *
   * PER PROVIDER, because an id belongs to a vendor: switching to Gemini
   * with `gpt-6-luna` still in the box used to produce a save that looked
   * fine and failed on the next reply.
   */
  private modelFrom(provider: AiProviderId, models: Record<string, unknown>): string {
    const stored = models[provider];
    if (typeof stored === 'string' && stored.trim().length > 0) return stored.trim();
    return provider === AiProvider.Gemini ? this.config.gemini.model : this.config.openai.model;
  }

  /** The saved model for any provider, not only the selected one. */
  async modelFor(provider: AiProviderId): Promise<string> {
    const stored = await this.settings.find(CHAT_SETTING_KEY);
    return this.modelFrom(provider, (stored?.value.models ?? {}) as Record<string, unknown>);
  }
}
