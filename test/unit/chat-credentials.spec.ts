import { describe, expect, it, vi } from 'vitest';
import { ChatConsoleService } from '@/modules/platform/chat-console.service';
import { WireCaptureService } from '@/modules/ai/wire-capture.service';
import { ChatService } from '@/modules/ai/chat.service';
import { TokenCipherService } from '@/shared/crypto';
import type { ModelCallRepository } from '@/database/repositories/model-call.repository';
import type { ModelRouter } from '@/modules/ai/model-router.service';
import type { PlatformSettingRepository } from '@/database/repositories/platform-setting.repository';
import type { AppConfigService } from '@/config';

/**
 * An API key typed into a console.
 *
 * Two properties carry this whole feature, and both fail silently if broken.
 * A key that reaches the database in plaintext looks identical in every test
 * that does not read the row. A key that comes back out of the API looks
 * identical to one that does not, until it is in a screenshot or a browser
 * cache. So both are asserted against the real cipher rather than a fake.
 */
const SECRET = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

function consoleWith(stored: Record<string, unknown> = {}) {
  const row = { value: stored, version: 4 };
  const put = vi.fn().mockImplementation((_key: string, value: Record<string, unknown>) => {
    row.value = value;
    row.version += 1;
    return Promise.resolve(row);
  });
  const settings = {
    find: vi.fn().mockImplementation(() => Promise.resolve(row)),
    put,
  } as unknown as PlatformSettingRepository;

  const cipher = new TokenCipherService({
    crypto: { activeKeyId: 'k1', keys: new Map([['k1', Buffer.alloc(32, 9)]]) },
  } as unknown as AppConfigService);

  const config = {
    openai: { model: 'gpt-6-luna', apiKey: '' },
    gemini: { model: 'gemini-3.5-flash-lite', apiKey: 'env-gemini-key' },
  } as unknown as AppConfigService;

  const chat = new ChatService(
    settings,
    { clientFor: () => ({ enabled: false }), available: () => [] } as unknown as ModelRouter,
    config,
    cipher,
    { record: vi.fn() } as unknown as ModelCallRepository,
    { enabled: false, record: vi.fn() } as unknown as WireCaptureService,
  );
  return { service: new ChatConsoleService(settings, chat, cipher), chat, row, put };
}

const SAVE = {
  provider: 'openai' as const,
  autoReply: false,
  models: { openai: 'gpt-6-luna', gemini: 'gemini-3.5-flash-lite' },
  prompt: 'You are a helpful assistant replying inside a business tool.',
  fallbackMessage: 'Back shortly.',
  mediaHoldMessage: 'Let me look.',
};

describe('a key typed into the console', () => {
  it('reaches the database encrypted, never as itself', async () => {
    const { service, row } = consoleWith();
    await service.update({ ...SAVE, apiKeys: { openai: SECRET } }, 1);

    const written = JSON.stringify(row.value);
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain('sk-proj');
    // The self-describing envelope the token cipher writes.
    expect(row.value.apiKeys).toMatchObject({ openai: expect.stringMatching(/^v1:k1:/) });
  });

  it('never comes back out of the console', async () => {
    const { service } = consoleWith();
    const overview = await service.update({ ...SAVE, apiKeys: { openai: SECRET } }, 1);

    expect(JSON.stringify(overview)).not.toContain(SECRET);
    expect(overview.keys.openai.source).toBe('console');
    // Four characters: enough to tell two keys apart, useless on its own.
    expect(overview.keys.openai.hint).toBe('6789');
  });

  it('survives a save that does not mention it', async () => {
    const { service, row } = consoleWith();
    await service.update({ ...SAVE, apiKeys: { openai: SECRET } }, 1);
    /*
     * The console cannot show a key, so it cannot put one back — every save
     * of the prompt omits it. Treating absence as "clear" would wipe a
     * working key whenever somebody reworded an instruction.
     */
    await service.update({ ...SAVE, prompt: 'A completely different instruction entirely.' }, 1);

    expect(row.value.apiKeys).toMatchObject({ openai: expect.stringMatching(/^v1:k1:/) });
  });

  it('is removed by an explicit null, and only by that', async () => {
    const { service, row } = consoleWith();
    await service.update({ ...SAVE, apiKeys: { openai: SECRET } }, 1);
    await service.update({ ...SAVE, apiKeys: { openai: null } }, 1);

    expect(row.value.apiKeys).toEqual({});
  });

  it('is what the assistant actually answers with', async () => {
    const { service, chat } = consoleWith();
    await service.update({ ...SAVE, apiKeys: { openai: SECRET } }, 1);

    // Decrypted only at the point of use, and only for the chosen provider.
    await expect(chat.enabledFor('openai')).resolves.toBe(true);
    await expect(chat.availableProviders()).resolves.toEqual(['openai', 'gemini']);
  });

  it('falls back to the environment when the console holds none', async () => {
    const { service, chat } = consoleWith();
    await service.update({ ...SAVE, provider: 'gemini' }, 1);

    const overview = await service.overview();
    expect(overview.keys.gemini.source).toBe('environment');
    expect(overview.keys.gemini.hint).toBeNull();
    expect(overview.keys.openai.source).toBe('none');
    await expect(chat.enabledFor('gemini')).resolves.toBe(true);
  });

  it('treats an unreadable key as absent rather than taking the assistant down', async () => {
    // What a lost or rotated master key looks like from here.
    const { chat } = consoleWith({ apiKeys: { gemini: 'v1:k9:not:decryptable' } });
    await expect(chat.enabledFor('gemini')).resolves.toBe(true); // the environment answers
    await expect(chat.keyStatus()).resolves.toMatchObject({
      gemini: { source: 'environment' },
    });
  });

  it("does not freeze today's default into the row when the box is blank", async () => {
    const { service, row } = consoleWith();
    await service.update({ ...SAVE, models: { openai: '', gemini: '' } }, 1);

    // Nothing stored: the environment's default answers, and keeps answering
    // if it changes.
    expect(row.value.models).toEqual({});
    const overview = await service.overview();
    expect(overview.models.openai).toBe('gpt-6-luna');
    expect(overview.models.gemini).toBe('gemini-3.5-flash-lite');
  });

  it('keeps a model with the provider that serves it', async () => {
    const { service } = consoleWith();
    const overview = await service.update(
      { ...SAVE, provider: 'gemini', models: { openai: 'gpt-6-luna', gemini: 'gemini-3.5-pro' } },
      1,
    );
    // Switching provider no longer leaves the other vendor's model id behind.
    expect(overview.models.gemini).toBe('gemini-3.5-pro');
    expect(overview.models.openai).toBe('gpt-6-luna');
  });
});
