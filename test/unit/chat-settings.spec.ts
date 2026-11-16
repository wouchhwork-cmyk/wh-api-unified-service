import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '@/modules/ai/chat.service';
import type { ModelRouter } from '@/modules/ai/model-router.service';
import type { PlatformSettingRepository } from '@/database/repositories/platform-setting.repository';
import type { AppConfigService } from '@/config';
import { TokenCipherService } from '@/shared/crypto';

/**
 * What the assistant is told, and who is told it.
 *
 * These are read from a row a human edits, which is exactly why the reading
 * is defensive: a typo in a provider name, a model emptied by accident, or a
 * row that has never been written must all leave a service that still
 * answers rather than one that throws at the first customer.
 */
function serviceWith(stored: Record<string, unknown> | null, version = 3) {
  const settings = {
    find: vi.fn().mockResolvedValue(stored === null ? null : { value: stored, version }),
    put: vi.fn(),
  } as unknown as PlatformSettingRepository;
  const chat = vi.fn().mockResolvedValue({
    text: 'drafted',
    usage: {},
    truncated: false,
    model: 'm',
    provider: 'openai',
  });
  const router = {
    chat,
    available: () => ['openai'],
    clientFor: () => ({ enabled: true }),
  } as unknown as ModelRouter;
  const config = {
    openai: { model: 'gpt-6-luna' },
    gemini: { model: 'gemini-3.5-flash-lite' },
  } as unknown as AppConfigService;
  /* The cipher is real: a test that fakes it proves nothing about a key
   * being stored unreadable, which is the whole point of storing one here. */
  const cipher = new TokenCipherService({
    crypto: { activeKeyId: 'k1', keys: new Map([['k1', Buffer.alloc(32, 7)]]) },
  } as unknown as AppConfigService);
  return { service: new ChatService(settings, router, config, cipher), chat, cipher };
}

describe('chat settings', () => {
  it('takes the saved row over the environment', async () => {
    const { service } = serviceWith({
      provider: 'gemini',
      models: { gemini: 'gemini-3.5-flash' },
      prompt: 'Be extremely brief.',
      fallbackMessage: 'Stepping away, back shortly.',
      mediaHoldMessage: 'Let me take a look at that…',
    });
    await expect(service.currentSettings()).resolves.toEqual({
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      prompt: 'Be extremely brief.',
      version: 3,
      autoReply: false,
      fallbackMessage: 'Stepping away, back shortly.',
      mediaHoldMessage: 'Let me take a look at that…',
    });
  });

  it('falls back to a model belonging to the chosen provider, not the other one', async () => {
    const openai = await serviceWith({ provider: 'openai' }).service.currentSettings();
    expect(openai.model).toBe('gpt-6-luna');

    const gemini = await serviceWith({ provider: 'gemini' }).service.currentSettings();
    // A gpt-* id is not something Google would answer to.
    expect(gemini.model).toBe('gemini-3.5-flash-lite');
  });

  it('ignores a provider name nobody implements rather than routing to it', async () => {
    const { service } = serviceWith({ provider: 'anthropic', models: { openai: 'claude' } });
    await expect(service.currentSettings()).resolves.toMatchObject({ provider: 'openai' });
  });

  it('still answers when the row has never been written', async () => {
    const settings = await serviceWith(null).service.currentSettings();
    expect(settings.provider).toBe('openai');
    expect(settings.model).toBe('gpt-6-luna');
    expect(settings.version).toBe(0);
    /*
     * The default is VOICE now, not rules. Everything about not inventing
     * facts and not obeying text found inside a conversation moved into the
     * system frame, where a console cannot edit it away.
     */
    expect(settings.prompt).toContain('Be warm and direct');
  });

  it('gives a caller the context section and keeps the rules to itself', async () => {
    const { service, chat } = serviceWith({ prompt: 'Never invent an opening hour.' });
    await service.reply(
      [{ role: 'user', text: 'when do you open?' }],
      '<business><name>Acme</name></business>',
    );

    const sent = chat.mock.calls[0]?.[1] as { instructions: string };
    /* The console's words, in the section that belongs to the console. */
    expect(sent.instructions).toContain('Never invent an opening hour.');
    expect(sent.instructions).toContain('<business_instructions');
    /* The caller's facts, in the section that belongs to facts. */
    expect(sent.instructions).toContain('<context>');
    expect(sent.instructions).toContain('<name>Acme</name>');
    /*
     * And the rules neither of them can reach, after both of them.
     */
    expect(sent.instructions).toContain('Never say or hint that you are an AI');
    expect(sent.instructions.indexOf('<output')).toBeGreaterThan(
      sent.instructions.indexOf('<context>'),
    );
  });

  it('stamps the version that produced the reply', async () => {
    const { service } = serviceWith({ prompt: 'Be brief.' }, 7);
    await expect(service.reply([{ role: 'user', text: 'hi' }])).resolves.toMatchObject({
      promptVersion: 7,
    });
  });
});
