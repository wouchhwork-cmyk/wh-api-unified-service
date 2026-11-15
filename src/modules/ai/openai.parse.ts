import { ChatError, ChatFailure } from './openai.errors';
import type { ChatReply, ChatUsage } from './openai.client';

/**
 * The reply, read out of a response object we did not design.
 *
 * READ DEFENSIVELY, not optimistically. `output_text` is an SDK convenience
 * over a structured `output` array, and a response can be well formed and
 * still carry no text in it — a model that spent its whole budget thinking
 * returns exactly that. So the array is the authority when the convenience
 * comes back empty, and an empty answer RAISES rather than returning '': a
 * caller must not be handed a blank reply that looks like a real one.
 */
export function parseChatReply(raw: unknown, model: string): ChatReply {
  const row = raw as
    | {
        output_text?: unknown;
        output?: unknown;
        status?: unknown;
        incomplete_details?: { reason?: unknown } | null;
      }
    | null
    | undefined;

  const truncated =
    row?.status === 'incomplete' && row?.incomplete_details?.reason === 'max_output_tokens';
  const text = replyTextOf(row);

  if (!text) {
    /*
     * NOT RETRYABLE EITHER WAY. Cut off at the cap, the same request produces
     * the same cut-off; silent otherwise, a second identical call is a second
     * bill for the same silence. The cap is configuration, so the fix is an
     * environment change — which is a thing the message has to say, because
     * "no reply" on its own sends somebody looking at the network.
     */
    throw new ChatError(
      ChatFailure.NoReply,
      truncated
        ? 'the reply was cut off at the output-token cap before any text was produced'
        : 'the model returned no text',
      false,
    );
  }

  return { text, usage: usageOf(raw), truncated, model };
}

function replyTextOf(row: { output_text?: unknown; output?: unknown } | null | undefined): string {
  if (typeof row?.output_text === 'string' && row.output_text.trim().length > 0) {
    return row.output_text.trim();
  }
  if (!Array.isArray(row?.output)) return '';

  const parts: string[] = [];
  for (const item of row.output as { type?: unknown; content?: unknown }[]) {
    /*
     * Only assistant messages. The same array carries reasoning items and
     * tool calls, and an internal thought is not something to show a person.
     */
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as { type?: unknown; text?: unknown }[]) {
      if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * What the call cost, as far as the provider is willing to say.
 *
 * EVERY FIELD IS NULLABLE, because a missing count and a count of zero are
 * different facts and a caller totting up spend must be able to tell them
 * apart. `reasoningTokens` is read because it is billed as output and never
 * shown — the gap between it and the visible reply is the whole case for the
 * cap that bounds them both.
 */
export function usageOf(raw: unknown): ChatUsage {
  const usage = (raw as { usage?: Record<string, unknown> } | null | undefined)?.usage;
  const read = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const inputDetails = usage?.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usage?.output_tokens_details as Record<string, unknown> | undefined;

  return {
    inputTokens: read(usage?.input_tokens),
    outputTokens: read(usage?.output_tokens),
    totalTokens: read(usage?.total_tokens),
    cachedInputTokens: read(inputDetails?.cached_tokens),
    reasoningTokens: read(outputDetails?.reasoning_tokens),
  };
}
