import { describe, expect, it, vi } from 'vitest';
import { ModelRouter } from '@/modules/ai/model-router.service';
import { ChatError, ChatFailure } from '@/modules/ai/chat.errors';
import { AiProvider } from '@/modules/ai/ai.provider';
import type { GeminiClient } from '@/modules/ai/gemini.client';
import type { OpenAiClient } from '@/modules/ai/openai.client';

/**
 * Which client answers, chosen by a value.
 *
 * The case worth protecting is the one that would never fail a test by
 * itself: a router that quietly answered with the OTHER provider when the
 * asked-for one has no key. The replies would look fine, the bill would
 * arrive at a vendor nobody chose, and a customer's conversation would have
 * been sent somewhere the environment never approved.
 */
function routerWith(openaiEnabled: boolean, geminiEnabled: boolean) {
  const openai = {
    id: AiProvider.OpenAi,
    enabled: openaiEnabled,
    chat: vi.fn().mockResolvedValue({ text: 'from openai' }),
  };
  const gemini = {
    id: AiProvider.Gemini,
    enabled: geminiEnabled,
    chat: vi.fn().mockResolvedValue({ text: 'from gemini' }),
  };
  const router = new ModelRouter(
    openai as unknown as OpenAiClient,
    gemini as unknown as GeminiClient,
  );
  return { router, openai, gemini };
}

const TURNS = [{ role: 'user' as const, text: 'hello' }];

describe('ModelRouter', () => {
  it('sends to the provider it was asked for, and only that one', async () => {
    const { router, openai, gemini } = routerWith(true, true);

    await expect(router.chat(AiProvider.OpenAi, { turns: TURNS })).resolves.toMatchObject({
      text: 'from openai',
    });
    expect(gemini.chat).not.toHaveBeenCalled();

    await expect(router.chat(AiProvider.Gemini, { turns: TURNS })).resolves.toMatchObject({
      text: 'from gemini',
    });
    expect(openai.chat).toHaveBeenCalledTimes(1);
  });

  it('refuses a provider with no key rather than answering with the other one', async () => {
    const { router, gemini } = routerWith(false, true);
    await expect(router.chat(AiProvider.OpenAi, { turns: TURNS })).rejects.toMatchObject({
      failureCode: ChatFailure.Disabled,
    });
    expect(gemini.chat).not.toHaveBeenCalled();
  });

  it('refuses a provider that does not exist here', () => {
    const { router } = routerWith(true, true);
    try {
      router.clientFor('anthropic' as never);
      expect.unreachable('an unknown provider must raise');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatError);
      expect((error as ChatError).failureCode).toBe(ChatFailure.Disabled);
    }
  });

  it('reports which providers this environment can actually use', () => {
    expect(routerWith(true, true).router.available()).toEqual(['openai', 'gemini']);
    expect(routerWith(false, true).router.available()).toEqual(['gemini']);
    expect(routerWith(false, false).router.available()).toEqual([]);
  });
});
