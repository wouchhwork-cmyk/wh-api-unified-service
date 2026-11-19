import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { AppConfigService } from '@/config';
import { CHAT_MAX_TURNS, CHAT_MAX_TURN_CHARS } from '@/shared/constants';
import { withDeadline } from '@/shared/utils/deadline';
import {
  AiProvider,
  type AiProviderId,
  type ChatProvider,
  type ChatReply,
  type ChatRequest,
  type ChatTurn,
} from './ai.provider';
import { ChatError, ChatFailure } from './chat.errors';
import { parseChatReply } from './openai.parse';

/**
 * The one place this service holds a text conversation with OpenAI.
 *
 * DELIBERATELY NARROW, like the Gemini client beside it. It takes turns and
 * returns a reply; it holds no prompt of its own, remembers nothing between
 * calls, and knows nothing about what the conversation is for. Who may chat,
 * about what, and with what history belongs to the service that calls it.
 *
 * STATELESS BY CHOICE. `store` is sent false on every call, so there is no
 * conversation living on OpenAI's servers to resume — the caller owns the
 * history and sends what it wants the model to have seen. It costs input
 * tokens on every turn and it is worth it: the alternative is a customer's
 * conversation sitting in someone else's account for at least 30 days.
 *
 * NOTHING CALLS IT UNLESS `OPENAI_ENABLED`. With the switch off it refuses
 * rather than returning something empty, because "the feature is off" and
 * "the model had nothing to say" must never look the same to a caller.
 */
@Injectable()
export class OpenAiClient implements ChatProvider {
  readonly id: AiProviderId = AiProvider.OpenAi;

  private client: OpenAI | null = null;
  /**
   * Which key built the cached client.
   *
   * A console can change the key between two calls, and an SDK built around
   * the old one would keep working until a restart — authenticating as a key
   * somebody has deliberately replaced, possibly a revoked one.
   */
  private clientKey: string | null = null;

  constructor(private readonly config: AppConfigService) {}

  get enabled(): boolean {
    return this.config.openai.enabled && this.config.openai.apiKey.length > 0;
  }

  /**
   * Built once, lazily.
   *
   * The key is passed EXPLICITLY rather than left to the SDK's environment
   * lookup. Constructed bare it reads `OPENAI_API_KEY` from the process,
   * which would work — and would mean the key in use was whatever the
   * environment happened to hold rather than what this service's own
   * validated config says. One source for a secret.
   *
   * Retries are the SDK's, bounded by config: it already knows which failures
   * are worth repeating (429s, 5xx, connection errors) and honours
   * `retry-after`, which is better behaviour than a loop of ours would have.
   */
  private sdk(override?: string): OpenAI {
    const apiKey = override?.trim() || this.config.openai.apiKey;
    if (apiKey.length === 0 || (!override && !this.enabled)) {
      throw new ChatError(ChatFailure.Disabled, 'openai has no key to answer with', false);
    }
    const { timeoutMs, maxRetries } = this.config.openai;
    if (this.client === null || this.clientKey !== apiKey) {
      this.client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries });
      this.clientKey = apiKey;
    }
    return this.client;
  }

  /**
   * Answers the last turn.
   *
   * The whole history goes up every time — see the note on the class — so a
   * caller that lets it grow pays for the growth on every reply. The bounds
   * below are the hard stop, not the budget.
   */
  async chat(request: ChatRequest): Promise<ChatReply> {
    const client = this.sdk(request.apiKey);
    const { model, reasoningEffort, storeResponses } = this.config.openai;
    const turns = this.checked(request.turns);
    const chosenModel = request.model?.trim() || model;
    const instructions = request.instructions?.trim() ?? '';
    /*
     * Empty means "say nothing about effort", and it has to become a value
     * the API's own type admits rather than an empty string it would reject.
     */
    const effort = reasoningEffort === '' ? null : reasoningEffort;

    /*
     * BUILT ONCE AND SENT, so the captured request is the object that
     * actually went out rather than a second one assembled to look like it.
     * A copy that drifts from what was sent is worse than no copy at all.
     */
    const body = {
      model: chosenModel,
      /*
       * SENT EXPLICITLY, because their default is the dangerous one:
       * omit it and OpenAI keeps the response for at least 30 days.
       */
      store: storeResponses,
      /*
       * NOTHING IS ASKED FOR THAT IS NOT NEEDED:
       *
       *   - NO `tools`. Web search is billed per call on top of tokens,
       *     and a declaration is tokens on every request besides. A chat
       *     that needs the web is a different feature, decided by the
       *     service, not a default of the transport.
       *   - NO stored response, so no history accrues against us.
       *   - THINKING IS OFF by default. Reasoning tokens bill as output
       *     at five times the input rate and are never shown to anyone.
       */
      input: turns.map((turn) => ({ role: turn.role, content: turn.text })),
      ...(instructions.length > 0 ? { instructions } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
    };

    let raw: unknown;
    try {
      raw = await withDeadline(
        client.responses.create(body),
        this.totalBudgetMs(),
        () =>
          new ChatError(
            ChatFailure.Timeout,
            `the model did not answer within ${this.totalBudgetMs()}ms`,
            true,
          ),
      );
    } catch (error) {
      if (error instanceof ChatError) throw error;
      /*
       * THE MESSAGE IS KEPT, THE REQUEST IS NOT. A provider error can quote
       * the input back, and the input here is somebody's conversation — so
       * what reaches a log is the failure, never the text that caused it.
       */
      throw new ChatError(
        ChatFailure.CallFailed,
        error instanceof Error ? error.message : 'the chat call failed',
        this.worthRetrying(error),
      );
    }

    const reply = parseChatReply(raw, chosenModel, this.id);
    return request.captureWire ? { ...reply, wire: { request: body, response: raw } } : reply;
  }

  /**
   * What goes up, checked before it costs anything.
   *
   * REFUSED, NOT TRIMMED. Silently dropping turns would make a model answer
   * a conversation nobody had, and silently cutting a message would have it
   * answer half a question — both arrive as a model that "gave a strange
   * reply" rather than as the limit they are.
   */
  private checked(turns: readonly ChatTurn[]): readonly ChatTurn[] {
    if (turns.length === 0) {
      throw new ChatError(ChatFailure.EmptyRequest, 'a chat call needs at least one turn', false);
    }
    if (turns.length > CHAT_MAX_TURNS) {
      throw new ChatError(
        ChatFailure.RequestTooLarge,
        `a chat call carries at most ${CHAT_MAX_TURNS} turns, and this one has ${turns.length}`,
        false,
      );
    }
    for (const turn of turns) {
      if (turn.text.trim().length === 0) {
        throw new ChatError(ChatFailure.EmptyRequest, 'a chat turn cannot be empty', false);
      }
      if (turn.text.length > CHAT_MAX_TURN_CHARS) {
        throw new ChatError(
          ChatFailure.RequestTooLarge,
          `a chat turn carries at most ${CHAT_MAX_TURN_CHARS} characters`,
          false,
        );
      }
    }
    return turns;
  }

  /**
   * The outer bound, and the reason it is a product rather than the timeout.
   *
   * `timeout` is PER ATTEMPT and the SDK retries beneath us, so a 30s timeout
   * with two retries is a 90s call. This states that total out loud so a
   * caller waiting on it cannot be surprised by arithmetic.
   */
  private totalBudgetMs(): number {
    const { timeoutMs, maxRetries } = this.config.openai;
    return timeoutMs * (maxRetries + 1);
  }

  /**
   * Whether the same call is worth making again.
   *
   * ONLY THE FAULTS THAT PASS. A rate limit clears and a 5xx is their bad
   * minute; a 400 means the request was wrong and a 401 means the key is, and
   * both are identically wrong the second time — for a person waiting on a
   * reply, a retry there is only a longer wait for the same failure.
   */
  private worthRetrying(error: unknown): boolean {
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status !== 'number') return false;
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
}
