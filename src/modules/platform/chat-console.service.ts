import { Injectable } from '@nestjs/common';
import { PlatformSettingRepository } from '@/database/repositories/platform-setting.repository';
import { CHAT_SETTING_KEY, ChatService } from '@/modules/ai/chat.service';
import type { AiProviderId } from '@/modules/ai/ai.provider';
import type { UpdateChatSettingsInput } from '@/shared/contracts/platform/chat-settings.contract';

export interface ChatSettingsOverview {
  readonly provider: AiProviderId;
  /** The platform-wide switch for automatic replies. Businesses opt in separately. */
  readonly autoReply: boolean;
  /** False when this environment has no key for the chosen provider. */
  readonly enabled: boolean;
  /**
   * The providers that do have a key here. The console shows the choice
   * either way — a provider being unusable today is a reason to say so, not
   * a reason to hide that it exists.
   */
  readonly availableProviders: readonly AiProviderId[];
  readonly model: string;
  readonly prompt: string;
  readonly promptVersion: number;
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
  ) {}

  async overview(): Promise<ChatSettingsOverview> {
    const current = await this.chat.currentSettings();
    return {
      provider: current.provider,
      autoReply: current.autoReply,
      enabled: this.chat.enabledFor(current.provider),
      availableProviders: this.chat.availableProviders(),
      model: current.model,
      prompt: current.prompt,
      promptVersion: current.version,
    };
  }

  /**
   * Saves all three fields, and returns the whole view back.
   *
   * NOTHING IS REPLAYED. Changing any of them changes what is said next, not
   * what was already said — re-answering past conversations would be a bill
   * nobody approved, triggered by editing a text box.
   *
   * THE MODEL IS SAVED WITHOUT BEING CHECKED AGAINST THE PROVIDER, because
   * nothing here could check it honestly: the list of models a key may use is
   * a property of the key, not of this code, and the one authority is the
   * next call. Switching provider without changing the model is therefore a
   * mistake the console can make — which is why the field sits beside the
   * provider rather than somewhere else in the page.
   */
  async update(
    input: UpdateChatSettingsInput,
    employeeId: number | null,
  ): Promise<ChatSettingsOverview> {
    await this.settings.put(
      CHAT_SETTING_KEY,
      {
        provider: input.provider,
        autoReply: input.autoReply,
        model: input.model,
        prompt: input.prompt,
      },
      employeeId,
    );
    return this.overview();
  }
}
