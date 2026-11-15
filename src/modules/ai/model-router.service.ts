import { Injectable } from '@nestjs/common';
import { ChatError, ChatFailure } from './chat.errors';
import { GeminiClient } from './gemini.client';
import { OpenAiClient } from './openai.client';
import {
  AiProvider,
  type AiProviderId,
  type ChatProvider,
  type ChatReply,
  type ChatRequest,
} from './ai.provider';

/**
 * Which client answers, decided by a value rather than by an import.
 *
 * THIS IS THE WHOLE POINT OF THE ABSTRACTION. Everything above it calls
 * `chat(provider, request)` and gets the same reply shape back, so switching
 * provider is a stored setting somebody edits — not a code change, a review
 * and a deploy. The clients stay separate and keep their own quirks, keys and
 * bills; only the choosing is shared.
 *
 * It REFUSES an unconfigured provider rather than falling back to the other
 * one. A silent fallback would send a customer's conversation to a vendor the
 * environment never gave a key to, and bill someone for it — and the symptom
 * would be replies that look fine.
 */
@Injectable()
export class ModelRouter {
  private readonly providers: ReadonlyMap<AiProviderId, ChatProvider>;

  constructor(openai: OpenAiClient, gemini: GeminiClient) {
    this.providers = new Map<AiProviderId, ChatProvider>([
      [AiProvider.OpenAi, openai],
      [AiProvider.Gemini, gemini],
    ]);
  }

  /** The client for a provider, whether or not this environment can use it. */
  clientFor(provider: AiProviderId): ChatProvider {
    const client = this.providers.get(provider);
    if (!client) {
      throw new ChatError(ChatFailure.Disabled, `${provider} is not a provider here`, false);
    }
    return client;
  }

  /** Which providers this environment actually has a key for. */
  available(): readonly AiProviderId[] {
    return [...this.providers.values()]
      .filter((client) => client.enabled)
      .map((client) => client.id);
  }

  /**
   * The universal call: name a provider, get a reply.
   *
   * The disabled check is here rather than only inside each client so the
   * refusal reads the same whichever provider was asked for — a caller
   * handling "that one is off" should not have to know two shapes of it.
   */
  async chat(provider: AiProviderId, request: ChatRequest): Promise<ChatReply> {
    const client = this.clientFor(provider);
    if (!client.enabled) {
      throw new ChatError(
        ChatFailure.Disabled,
        `${provider} has no key in this environment`,
        false,
      );
    }
    return client.chat(request);
  }
}
