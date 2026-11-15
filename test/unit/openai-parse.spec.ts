import { describe, expect, it } from 'vitest';
import { parseChatReply, usageOf } from '@/modules/ai/openai.parse';
import { ChatError, ChatFailure } from '@/modules/ai/openai.errors';

/**
 * Reading a reply out of a response shape we do not own.
 *
 * The cases that matter are the ones where the call SUCCEEDED and there is
 * still nothing to show: a model that spent its whole budget thinking returns
 * HTTP 200 with an empty `output_text`, and a client that trusts the status
 * code hands somebody a blank message as though the model had said it.
 */
describe('parseChatReply', () => {
  it('takes the convenience field when it has text', () => {
    const reply = parseChatReply({ output_text: '  hello there  ' }, 'gpt-6-luna');
    expect(reply.text).toBe('hello there');
    expect(reply.truncated).toBe(false);
    expect(reply.model).toBe('gpt-6-luna');
  });

  it('falls back to the output array when the convenience field is empty', () => {
    const reply = parseChatReply(
      {
        output_text: '',
        output: [
          { type: 'reasoning', content: [{ type: 'output_text', text: 'thinking out loud' }] },
          { type: 'message', content: [{ type: 'output_text', text: 'the real answer' }] },
        ],
      },
      'gpt-6-luna',
    );
    expect(reply.text).toBe('the real answer');
  });

  it('never shows reasoning as if it were the reply', () => {
    expect(() =>
      parseChatReply(
        {
          output: [
            { type: 'reasoning', content: [{ type: 'output_text', text: 'private thought' }] },
          ],
        },
        'gpt-6-luna',
      ),
    ).toThrow(ChatError);
  });

  it('reports a reply that ran into the output cap', () => {
    const reply = parseChatReply(
      {
        output_text: 'half a sent',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
      'gpt-6-luna',
    );
    expect(reply.truncated).toBe(true);
    expect(reply.text).toBe('half a sent');
  });

  it('refuses an empty answer instead of returning a blank message', () => {
    try {
      parseChatReply({ output_text: '   ' }, 'gpt-6-luna');
      expect.unreachable('an empty reply must raise');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatError);
      expect((error as ChatError).failureCode).toBe(ChatFailure.NoReply);
      expect((error as ChatError).retryable).toBe(false);
    }
  });

  it('says so when the cap ate the whole budget before any text', () => {
    try {
      parseChatReply(
        {
          output_text: '',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        },
        'gpt-6-luna',
      );
      expect.unreachable('an empty reply must raise');
    } catch (error) {
      expect((error as ChatError).message).toContain('output-token cap');
    }
  });
});

describe('usageOf', () => {
  it('reads every count the provider reports, thinking included', () => {
    expect(
      usageOf({
        usage: {
          input_tokens: 120,
          output_tokens: 34,
          total_tokens: 154,
          input_tokens_details: { cached_tokens: 64 },
          output_tokens_details: { reasoning_tokens: 12 },
        },
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 34,
      totalTokens: 154,
      cachedInputTokens: 64,
      reasoningTokens: 12,
    });
  });

  it('keeps a missing count distinct from a zero', () => {
    const usage = usageOf({ usage: { input_tokens: 0 } });
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBeNull();
    expect(usage.reasoningTokens).toBeNull();
  });

  it('survives a response with no usage at all', () => {
    expect(usageOf({}).totalTokens).toBeNull();
    expect(usageOf(null).totalTokens).toBeNull();
  });
});
