/**
 * The shape every model provider presents, so nothing above this line has to
 * know which one answered.
 *
 * THE PROVIDER IS AN ARGUMENT, NOT AN IMPLEMENTATION DETAIL. Callers name the
 * provider they want and get back the same `ChatReply` whichever one it was —
 * which is what makes the choice a setting somebody can change rather than a
 * release somebody has to ship. The two differ in ways that matter (Gemini
 * reads audio and video inline, OpenAI is cheaper per text token), so the
 * right answer changes with the job and with the week.
 */

export const AiProvider = {
  OpenAi: 'openai',
  Gemini: 'gemini',
} as const;

export type AiProviderId = (typeof AiProvider)[keyof typeof AiProvider];

/** Every provider id, for validating one that arrived from outside. */
export const AI_PROVIDER_IDS = Object.values(AiProvider) as readonly AiProviderId[];

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === 'string' && AI_PROVIDER_IDS.includes(value as AiProviderId);
}

/** Who said it. The model's own replies come back as `assistant`. */
export type ChatRole = 'user' | 'assistant';

export interface ChatTurn {
  readonly role: ChatRole;
  readonly text: string;
}

export interface ChatUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  /** Input served from cache, billed at a fraction. Null where unreported. */
  readonly cachedInputTokens: number | null;
  /** Billed as output and never shown to anybody. Null where unreported. */
  readonly reasoningTokens: number | null;
}

/**
 * One call's bodies, exactly as they crossed the wire.
 *
 * ONLY BUILT WHEN ASKED FOR. `request` is the object handed to the provider
 * SDK, `response` is what it gave back before anything parsed it — the two
 * things nothing else in this service keeps, and the only way to see what a
 * model was really told and really said rather than what we rebuilt or
 * extracted afterwards.
 *
 * NEVER CARRIES THE KEY. A request body holds the prompt and the model id;
 * authentication lives on the SDK, not in here.
 */
export interface ChatWire {
  readonly request: unknown;
  readonly response: unknown;
}

export interface ChatReply {
  readonly text: string;
  readonly usage: ChatUsage;
  /** The cap stopped it mid-sentence. The text is real but unfinished. */
  readonly truncated: boolean;
  readonly model: string;
  /** Which provider actually answered — the one thing a caller cannot infer. */
  readonly provider: AiProviderId;
  /** Present only when the request asked for it. See `ChatWire`. */
  readonly wire?: ChatWire;
}

export interface ChatRequest {
  /** Oldest first. The last turn is what the model is answering. */
  readonly turns: readonly ChatTurn[];
  /** The standing instruction — who the model is, how it should answer. */
  readonly instructions?: string;
  /** Overrides the provider's configured model for this one call. */
  readonly model?: string;
  /**
   * The key to answer with, when it comes from somewhere other than the
   * environment — a console, today.
   *
   * SECRET. It is never logged, never echoed into an error, and never put in
   * a ledger row. The client uses it to build an SDK and nothing else.
   */
  readonly apiKey?: string;
  /**
   * Hand back the exact bodies alongside the answer.
   *
   * A REQUEST-LEVEL SWITCH rather than a client-level one, so the decision
   * stays with the service that knows whose conversation this is and
   * whether anybody asked to watch it. Off, nothing extra is built.
   */
  readonly captureWire?: boolean;
}

/**
 * What a provider must be able to do to be routable.
 *
 * Deliberately ONE METHOD. A provider is not a grab bag of everything its
 * vendor sells — it is the capability this product dispatches on. Media
 * description is a second capability with a different shape and a different
 * set of providers that can honestly implement it (OpenAI's API takes no
 * audio or video inline), so it is not bolted on here.
 */
export interface ChatProvider {
  readonly id: AiProviderId;
  /** False when this environment has no key for it. */
  readonly enabled: boolean;
  chat(request: ChatRequest): Promise<ChatReply>;
}
