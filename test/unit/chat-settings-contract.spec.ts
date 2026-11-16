import { describe, expect, it } from 'vitest';
import { UpdateChatSettingsSchema } from '@/shared/contracts/platform/chat-settings.contract';

/**
 * What a console may save as the assistant's instruction.
 *
 * Both fields reach a paid API unchanged, which is what makes the bounds
 * worth testing: a prompt is billed on every single reply, and a model id is
 * only ever found to be wrong by spending a call to discover it.
 */
const VALID = {
  provider: 'openai',
  autoReply: false,
  fallbackMessage: 'Stepping away, back shortly.',
  mediaHoldMessage: 'Let me take a look at that…',
  models: { openai: 'gpt-6-luna', gemini: 'gemini-3.5-flash-lite' },
  prompt: 'You are a helpful assistant replying inside a business tool. Be brief.',
};

function issuesFor(overrides: Record<string, unknown>): string[] {
  const result = UpdateChatSettingsSchema.safeParse({ ...VALID, ...overrides });
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('chat settings contract', () => {
  it('accepts a model id and an instruction', () => {
    expect(issuesFor({})).toEqual([]);
  });

  it('takes either provider, and nothing else', () => {
    expect(issuesFor({ provider: 'gemini' })).toEqual([]);
    expect(issuesFor({ provider: 'anthropic' })).toContain('provider');
    expect(issuesFor({ provider: '' })).toContain('provider');
  });

  it('trims both text fields rather than storing the typist’s whitespace', () => {
    const parsed = UpdateChatSettingsSchema.parse({
      provider: 'openai',
      autoReply: false,
      fallbackMessage: '  Stepping away.  ',
      mediaHoldMessage: 'Let me look.',
      models: { openai: '  gpt-6-luna  ', gemini: 'gemini-3.5-flash-lite' },
      prompt: `  ${VALID.prompt}  `,
    });
    expect(parsed.models.openai).toBe('gpt-6-luna');
    expect(parsed.prompt).toBe(VALID.prompt);
  });

  it('takes any model id that looks like one, because the list is not ours to keep', () => {
    for (const model of ['gpt-6-luna', 'gpt-5.4-mini', 'gpt-6.1-terra', 'o4-mini']) {
      expect(
        issuesFor({ models: { openai: model, gemini: 'gemini-3.5-flash-lite' } }),
        model,
      ).toEqual([]);
    }
  });

  it('refuses something that is not a model id at all', () => {
    for (const model of ['', '  ', 'a model', '../../etc/passwd', 'https://evil/x', '-leading']) {
      expect(
        issuesFor({ models: { openai: model, gemini: 'gemini-3.5-flash-lite' } }),
        JSON.stringify(model),
      ).toContain('models.openai');
    }
  });

  it('refuses an instruction too short to be one, or long enough to be a bill', () => {
    expect(issuesFor({ prompt: 'be nice' })).toContain('prompt');
    expect(issuesFor({ prompt: 'x'.repeat(8_001) })).toContain('prompt');
    expect(issuesFor({ prompt: 'x'.repeat(8_000) })).toEqual([]);
  });

  it('accepts an empty fallback, which means saying nothing at all', () => {
    // A real choice: a business may prefer silence to an apology it did not
    // write. Only ABSENCE is refused, because that is a client that forgot.
    expect(issuesFor({ fallbackMessage: '' })).toEqual([]);
    expect(issuesFor({ fallbackMessage: 'x'.repeat(501) })).toContain('fallbackMessage');
  });

  it('refuses a field nobody asked for, rather than silently dropping it', () => {
    // A `temperature` that parsed and then went nowhere would read, from the
    // console, exactly like one that worked.
    const result = UpdateChatSettingsSchema.safeParse({ ...VALID, temperature: 2 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain('temperature');
  });

  it('refuses a half-filled save, because the save is a full restatement', () => {
    expect(UpdateChatSettingsSchema.safeParse({ models: VALID.models }).success).toBe(false);
    expect(UpdateChatSettingsSchema.safeParse({ prompt: VALID.prompt }).success).toBe(false);
    expect(
      UpdateChatSettingsSchema.safeParse({ provider: 'openai', models: VALID.models }).success,
    ).toBe(false);
    // The switch that sends real messages is never inferred from silence.
    const { autoReply: _omitted, ...withoutSwitch } = VALID;
    expect(UpdateChatSettingsSchema.safeParse(withoutSwitch).success).toBe(false);
  });
});
