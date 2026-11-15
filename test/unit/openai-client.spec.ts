import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '@/config';
import { OpenAiClient } from '@/modules/ai/openai.client';
import { ChatError, ChatFailure } from '@/modules/ai/openai.errors';
import { CHAT_MAX_TURNS, CHAT_MAX_TURN_CHARS } from '@/shared/constants';

/**
 * What leaves this service when somebody chats, and what never does.
 *
 * The assertions about the REQUEST are the point of the file. Every one of
 * them is a cost or a privacy decision that is invisible at the call site and
 * silent when it regresses: a dropped `store: false` leaves a customer's
 * conversation on OpenAI's servers for a month and nothing fails, a lost
 * output cap bills for thinking nobody reads, and a `tools` array that
 * creeps in is a per-call charge on top of tokens. None of that shows up in
 * a response.
 */
const OPENAI = {
  enabled: true,
  apiKey: 'sk-test-not-a-real-key',
  model: 'gpt-6-luna',
  timeoutMs: 30_000,
  maxRetries: 2,
  maxOutputTokens: 600,
  reasoningEffort: 'none' as const,
  storeResponses: false,
};

function clientWith(
  overrides: Partial<typeof OPENAI>,
  create = vi.fn().mockResolvedValue({ output_text: 'hello' }),
): { client: OpenAiClient; create: ReturnType<typeof vi.fn> } {
  const config = { openai: { ...OPENAI, ...overrides } } as unknown as AppConfigService;
  const client = new OpenAiClient(config);
  // Seeded so the lazy `??=` never builds a real SDK: no network, no key check.
  Reflect.set(client, 'client', { responses: { create } });
  return { client, create };
}

/** The thrown error, typed, without a test that passes when nothing throws. */
async function failureOf(work: Promise<unknown>): Promise<ChatError> {
  try {
    await work;
  } catch (caught) {
    return caught as ChatError;
  }
  throw new Error('the call was expected to fail, and did not');
}

describe('OpenAiClient configuration', () => {
  it('is off without a key, however enabled the switch says it is', () => {
    const { client } = clientWith({ apiKey: '' });
    expect(client.enabled).toBe(false);
  });

  it('refuses rather than returning nothing when the provider is off', async () => {
    const { client, create } = clientWith({ enabled: false });
    await expect(client.chat({ turns: [{ role: 'user', text: 'hi' }] })).rejects.toMatchObject({
      failureCode: ChatFailure.Disabled,
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('OpenAiClient request', () => {
  it('sends the cost and retention decisions on every call', async () => {
    const { client, create } = clientWith({});
    await client.chat({ turns: [{ role: 'user', text: 'hi' }], instructions: '  be brief  ' });

    const sent = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.store).toBe(false);
    expect(sent.max_output_tokens).toBe(600);
    expect(sent.reasoning).toEqual({ effort: 'none' });
    expect(sent.instructions).toBe('be brief');
    expect(sent.model).toBe('gpt-6-luna');
    // Nothing that bills on top of tokens, and nothing that keeps state.
    expect(sent.tools).toBeUndefined();
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.stream).toBeUndefined();
  });

  it('omits the reasoning field entirely when no effort is configured', async () => {
    const { client, create } = clientWith({ reasoningEffort: '' as never });
    await client.chat({ turns: [{ role: 'user', text: 'hi' }] });
    const sent = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('reasoning' in sent).toBe(false);
  });

  it('sends the turns in order, oldest first', async () => {
    const { client, create } = clientWith({});
    await client.chat({
      turns: [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'second' },
        { role: 'user', text: 'third' },
      ],
    });
    expect((create.mock.calls[0]?.[0] as { input: unknown }).input).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]);
  });

  it('lets one call override the model and the cap without changing the next', async () => {
    const { client, create } = clientWith({});
    await client.chat({
      turns: [{ role: 'user', text: 'hi' }],
      model: 'gpt-6.1-terra',
      maxOutputTokens: 64,
    });
    await client.chat({ turns: [{ role: 'user', text: 'hi again' }] });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-6.1-terra',
      max_output_tokens: 64,
    });
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      model: 'gpt-6-luna',
      max_output_tokens: 600,
    });
  });
});

describe('OpenAiClient refusals', () => {
  it('will not call the model with nothing to answer', async () => {
    const { client, create } = clientWith({});
    await expect(client.chat({ turns: [] })).rejects.toMatchObject({
      failureCode: ChatFailure.EmptyRequest,
    });
    await expect(client.chat({ turns: [{ role: 'user', text: '   ' }] })).rejects.toMatchObject({
      failureCode: ChatFailure.EmptyRequest,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a history past the bound instead of quietly dropping the oldest turns', async () => {
    const { client, create } = clientWith({});
    const turns = Array.from({ length: CHAT_MAX_TURNS + 1 }, () => ({
      role: 'user' as const,
      text: 'hi',
    }));
    await expect(client.chat({ turns })).rejects.toMatchObject({
      failureCode: ChatFailure.RequestTooLarge,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses one oversized turn rather than sending half a question', async () => {
    const { client } = clientWith({});
    await expect(
      client.chat({ turns: [{ role: 'user', text: 'x'.repeat(CHAT_MAX_TURN_CHARS + 1) }] }),
    ).rejects.toMatchObject({ failureCode: ChatFailure.RequestTooLarge });
  });
});

describe('OpenAiClient failures', () => {
  it('keeps the provider’s message but never the conversation that caused it', async () => {
    const secret = 'my card number is 4111 1111 1111 1111';
    const create = vi.fn().mockRejectedValue(new Error('400 invalid request'));
    const { client } = clientWith({}, create);

    const error = await failureOf(client.chat({ turns: [{ role: 'user', text: secret }] }));

    expect(error).toBeInstanceOf(ChatError);
    expect(error.message).toBe('400 invalid request');
    expect(JSON.stringify(error)).not.toContain('4111');
  });

  it('retries only what a second attempt could fix', async () => {
    const cases: { status: number | undefined; retryable: boolean }[] = [
      { status: 429, retryable: true },
      { status: 503, retryable: true },
      { status: 400, retryable: false },
      { status: 401, retryable: false },
      { status: undefined, retryable: false },
    ];
    for (const { status, retryable } of cases) {
      const failure = Object.assign(new Error('nope'), status === undefined ? {} : { status });
      const { client } = clientWith({}, vi.fn().mockRejectedValue(failure));
      const error = await failureOf(client.chat({ turns: [{ role: 'user', text: 'hi' }] }));
      expect(error.retryable, `status ${String(status)}`).toBe(retryable);
    }
  });

  it('gives up on the whole call, not on each of the SDK’s attempts', async () => {
    vi.useFakeTimers();
    const { client } = clientWith(
      { timeoutMs: 1_000, maxRetries: 2 },
      vi.fn(() => new Promise(() => {})),
    );
    const settled = client.chat({ turns: [{ role: 'user', text: 'hi' }] });
    const assertion = expect(settled).rejects.toMatchObject({ failureCode: ChatFailure.Timeout });
    // One attempt's timeout is not the deadline: three attempts are.
    await vi.advanceTimersByTimeAsync(2_999);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    vi.useRealTimers();
  });
});
