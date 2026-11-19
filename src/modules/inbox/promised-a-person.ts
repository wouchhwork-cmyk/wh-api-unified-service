/**
 * Did this reply promise the customer a human being?
 *
 * WHY THIS EXISTS. The assistant answered "Hello! A colleague will be with
 * you shortly to help sort this out." and set `handoff` to null — so the
 * customer was told somebody was coming while the system recorded that
 * nobody was needed. No flag was raised, nothing appeared in any inbox, and
 * nobody was ever going to arrive.
 *
 * It is the mirror of the earlier failure, where it set a handoff and then
 * repeated the promise forever. Both are the same underlying thing: the
 * sentence and the field disagreeing. The prompt already forbids this in
 * both directions and lost both times, so the agreement is checked here
 * instead of asked for.
 *
 * A PROMISE IS A DEBT. Once those words are sent, the business owes that
 * person a colleague whatever the model meant — so the safe reading is to
 * raise the flag and let somebody glance at it and clear it. The other way
 * round, the customer waits for somebody who was never told.
 *
 * DELIBERATELY NARROW. It matches a future-tense promise of a PERSON and
 * nothing else. A reply that merely mentions colleagues ("my colleagues
 * handle refunds") is not a promise, and raising a flag on it would teach
 * everybody to ignore flags.
 */
/** Who counts as "a person" being promised. */
const PERSON = String.raw`(?:colleague|team\s*members?|team\s*mates?|agent|representative|rep|human|person|member\s+of\s+our\s+team)`;

/** The determiners that make it one of OURS rather than a general noun. */
const OURS = String.raw`(?:a|an|one\s+of\s+our|our|my|another|the)`;

const PROMISES = [
  /*
   * "A colleague will be with you", "one of our team members will get back
   * to you". The gap allows a clause between the two — "a colleague will,
   * as soon as they are free, ..." — but stops at a sentence boundary so a
   * promise cannot be assembled out of two unrelated sentences.
   */
  new RegExp(String.raw`\b${OURS}\s+${PERSON}\b[^.!?]{0,60}\bwill\b`, 'i'),
  new RegExp(
    String.raw`\b${PERSON}\b[^.!?]{0,40}\b(?:will\s+(?:be|get)\s+(?:with|back\s+to)\s+you|is\s+on\s+(?:their|its)\s+way|will\s+take\s+(?:this\s+|it\s+)?over)`,
    'i',
  ),
  /\bsomeone\s+(?:from\s+(?:our|the)\s+team\s+)?will\s+(?:be\s+with\s+you|get\s+back\s+to\s+you|contact\s+you|reach\s+out)/i,
  /*
   * "I will escalate this to a colleague" — a promise made about what the
   * ASSISTANT will do, which commits the business just as firmly.
   */
  new RegExp(
    String.raw`\b(?:transfer|escalate|pass|hand)(?:ing|ed)?\b[^.!?]{0,30}\bto\s+${OURS}\s+${PERSON}`,
    'i',
  ),
  new RegExp(String.raw`\bconnecting\s+you\s+(?:with|to)\s+${OURS}\s+${PERSON}`, 'i'),
];

export function promisedAPerson(reply: string | null | undefined): boolean {
  if (!reply) return false;

  /*
   * QUESTIONS ARE NOT PROMISES. "Would you like me to pass this to a
   * colleague?" offers one and commits to nothing — treating it as a
   * promise would raise a flag every time the assistant politely asks, and
   * flags that fire on nothing get ignored when they fire on something.
   *
   * Split on sentence ends, keep the terminator so a question can be told
   * apart, and test only the statements.
   */
  const statements = reply
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !sentence.trimEnd().endsWith('?'));

  return statements.some((sentence) => PROMISES.some((pattern) => pattern.test(sentence)));
}
