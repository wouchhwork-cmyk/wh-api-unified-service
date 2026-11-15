/**
 * Why a chat call failed, in the only terms a caller needs: can it be tried
 * again, and what code gets recorded.
 *
 * RETRYABLE IS THE NARROW SET, which is the opposite of how the media ledger
 * treats it — and deliberately so. A description is produced once by a worker
 * that can afford to come back in a minute; a chat reply is somebody waiting,
 * and re-sending a request that was refused on its merits spends money to
 * arrive at the same refusal while they wait twice as long.
 */
export class ChatError extends Error {
  constructor(
    readonly failureCode: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export const ChatFailure = {
  /** The provider is switched off in this environment, or has no key. */
  Disabled: 'CHAT_DISABLED',
  /** Nothing was asked. A model call with no turns is a bill for nothing. */
  EmptyRequest: 'CHAT_EMPTY_REQUEST',
  /** More history, or a longer message, than we will send in one call. */
  RequestTooLarge: 'CHAT_REQUEST_TOO_LARGE',
  /** The call itself failed — network, auth, rate limit, or a refusal. */
  CallFailed: 'CHAT_CALL_FAILED',
  /** The provider did not answer inside the deadline. */
  Timeout: 'CHAT_TIMEOUT',
  /** It answered, but with no text we can show anybody. */
  NoReply: 'CHAT_NO_REPLY',
} as const;
