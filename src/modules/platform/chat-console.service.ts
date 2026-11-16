import { Injectable } from '@nestjs/common';
import { PlatformSettingRepository } from '@/database/repositories/platform-setting.repository';
import { CHAT_SETTING_KEY, ChatService } from '@/modules/ai/chat.service';
import { AI_PROVIDER_IDS, type AiProviderId } from '@/modules/ai/ai.provider';
import { TokenCipherService } from '@/shared/crypto';
import type { UpdateChatSettingsInput } from '@/shared/contracts/platform/chat-settings.contract';

export interface ChatSettingsOverview {
  readonly provider: AiProviderId;
  /** False when the chosen provider has no key anywhere. */
  readonly enabled: boolean;
  /** The providers that can actually answer, from a console key or the environment. */
  readonly availableProviders: readonly AiProviderId[];
  /** The platform-wide switch for automatic replies. Businesses opt in separately. */
  readonly autoReply: boolean;
  /** One model per provider: an id belongs to the vendor that serves it. */
  readonly models: Readonly<Record<AiProviderId, string>>;
  /**
   * WHERE each key comes from, never the key.
   *
   * A console that can display a key is a console that leaks one — through a
   * screenshot, a browser cache, a support session over somebody's shoulder.
   * The last four characters of a console-held key are enough to tell two
   * apart and useless to anybody who obtains them.
   */
  readonly keys: Readonly<
    Record<AiProviderId, { source: 'console' | 'environment' | 'none'; hint: string | null }>
  >;
  readonly prompt: string;
  readonly promptVersion: number;
  /** What a customer hears when the assistant cannot answer. */
  readonly fallbackMessage: string;
  /** What they hear while their photo is still being looked at. */
  readonly mediaHoldMessage: string;
}

/**
 * What staff see and change about how the assistant replies.
 *
 * SETTINGS ONLY, AND THAT IS NOT AN OVERSIGHT. The media console reports a
 * queue beside its prompt because media analysis keeps a ledger of every
 * piece it has described; chat keeps no such record, so there is nothing
 * honest to count here. A tile that always reads zero is worse than no tile.
 */
@Injectable()
export class ChatConsoleService {
  constructor(
    private readonly settings: PlatformSettingRepository,
    private readonly chat: ChatService,
    private readonly cipher: TokenCipherService,
  ) {}

  async overview(): Promise<ChatSettingsOverview> {
    const [current, available, keys] = await Promise.all([
      this.chat.currentSettings(),
      this.chat.availableProviders(),
      this.chat.keyStatus(),
    ]);

    return {
      provider: current.provider,
      enabled: available.includes(current.provider),
      availableProviders: available,
      autoReply: current.autoReply,
      models: await this.models(),
      keys,
      prompt: current.prompt,
      promptVersion: current.version,
      fallbackMessage: current.fallbackMessage,
      mediaHoldMessage: current.mediaHoldMessage,
    };
  }

  /**
   * Saves the page, and returns it without the keys.
   *
   * NOTHING IS REPLAYED. Changing any of this changes what is said next, not
   * what was already said — re-answering past conversations would be a bill
   * nobody approved, triggered by editing a text box.
   */
  async update(
    input: UpdateChatSettingsInput,
    employeeId: number | null,
  ): Promise<ChatSettingsOverview> {
    const existing = await this.settings.find(CHAT_SETTING_KEY);
    const envelopes = { ...((existing?.value.apiKeys ?? {}) as Record<string, unknown>) };

    /*
     * THREE STATES, KEPT APART. Absent means the console is not talking
     * about this key — which is what every save sends for a key nobody
     * retyped, because the form has nothing to put back. `null` means
     * remove it. A string sets a new one, encrypted here and never held in
     * plaintext anywhere but this line.
     */
    for (const provider of AI_PROVIDER_IDS) {
      const supplied = input.apiKeys?.[provider];
      if (supplied === undefined) continue;
      if (supplied === null) delete envelopes[provider];
      else envelopes[provider] = this.cipher.encrypt(supplied);
    }

    await this.settings.put(
      CHAT_SETTING_KEY,
      {
        provider: input.provider,
        autoReply: input.autoReply,
        /*
         * ONLY WHAT WAS CHOSEN. An empty box means "use the default", and
         * writing '' for it would freeze today's default into the row — so
         * tomorrow's change to configuration would silently not apply.
         */
        models: this.chosenModels(input.models),
        apiKeys: envelopes,
        prompt: input.prompt,
        fallbackMessage: input.fallbackMessage,
        mediaHoldMessage: input.mediaHoldMessage,
      },
      employeeId,
    );
    return this.overview();
  }

  /**
   * The models worth storing.
   *
   * ONLY WHAT WAS CHOSEN. An empty box means "use the default", and writing
   * '' for it would freeze today's default into the row — so a later change
   * to configuration would silently not apply to a business that had simply
   * never typed a model.
   */
  private chosenModels(models: Record<AiProviderId, string>): Record<string, string> {
    const chosen: Record<string, string> = {};
    for (const provider of AI_PROVIDER_IDS) {
      const model = models[provider].trim();
      if (model.length > 0) chosen[provider] = model;
    }
    return chosen;
  }

  /** The saved model per provider, falling back to each one's environment default. */
  private async models(): Promise<Record<AiProviderId, string>> {
    const models = {} as Record<AiProviderId, string>;
    for (const provider of AI_PROVIDER_IDS) {
      models[provider] = await this.chat.modelFor(provider);
    }
    return models;
  }
}
