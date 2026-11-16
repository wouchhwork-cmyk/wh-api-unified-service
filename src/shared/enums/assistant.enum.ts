/**
 * Where one owed reply has got to.
 *
 * THE SAME SHAPE AS EVERY OTHER LEDGER HERE, deliberately. A reply the
 * assistant owes somebody is work claimed, attempted and settled exactly like
 * a queued projection or a queued media description — and the thing that was
 * missing before this existed was the row itself: if the worker died between
 * accepting a customer's message and answering it, nothing said an answer was
 * ever owed.
 */
export enum AssistantReplyStatus {
  /** Owed, and not yet attempted. */
  Pending = 'pending',
  /** Claimed by a worker and in flight right now. */
  InFlight = 'in_flight',
  /** A reply went out. `message_id` names it. */
  Sent = 'sent',
  /**
   * Deliberately not answered, and never will be.
   *
   * Terminal and ordinary: the switch was off, a colleague answered first,
   * the thread closed, or the model read it and judged that nothing needed
   * saying. `skip_reason` says which.
   */
  Skipped = 'skipped',
  /** Attempted and failed; retried while attempts remain. */
  Failed = 'failed',
  /** Given up on: attempts exhausted, or a failure that will not change. */
  Unavailable = 'unavailable',
}
