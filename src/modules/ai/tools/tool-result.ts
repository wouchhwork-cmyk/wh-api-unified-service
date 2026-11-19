import type { RequestedTool } from './tool.contract';

/**
 * What a tool did, written back into the next call.
 *
 * THE NEXT CALL IS A STRANGER TO THIS ONE. Nothing carries over between two
 * model calls except the text we put in front of the second — so a result
 * arriving on its own is a number with no question attached. The reason the
 * model gave for asking travels with it, which is why the contract demands
 * one.
 *
 * KEPT APART FROM <context>, in a section of its own. The context is what we
 * already knew; this is what was fetched DURING this answer, at the model's
 * own request, and the difference matters when a lookup fails: "we hold no
 * phone number for them" and "the lookup errored" lead to different replies,
 * and only one of them is a fact about the customer.
 */

export const ToolOutcome = {
  Ok: 'ok',
  /** The tool ran and found nothing. A real answer, not a failure. */
  Empty: 'empty',
  /** The model asked for something that does not exist. */
  Unknown: 'unknown',
  /** It named a tool but did not give it what it needs. */
  Incomplete: 'incomplete',
  /** It ran and threw, or the thing it calls was unreachable. */
  Failed: 'failed',
  /** Refused before running: too many calls in one answer. */
  Refused: 'refused',
} as const;

export type ToolOutcome = (typeof ToolOutcome)[keyof typeof ToolOutcome];

export interface ToolRun {
  readonly tool: RequestedTool;
  readonly outcome: ToolOutcome;
  /** What came back, already safe to show a model. Null when nothing did. */
  readonly data: unknown;
  /** Why it did not work, in words the model can act on. */
  readonly note: string | null;
  readonly durationMs: number;
}

/**
 * The `<tool_results>` section for the next call.
 *
 * ONE SECTION FOR THE WHOLE ROUND, in the order they were asked for, so a
 * model that called two tools reads them as one piece of work rather than
 * two unrelated facts.
 */
export function renderToolResults(
  runs: readonly ToolRun[],
  /**
   * Whether the turn that ASKED for these also set a handoff.
   *
   * See the rule this emits. It is a fact about what the model did one turn
   * ago, which it can no longer see.
   */
  handoffPending = false,
): string {
  if (runs.length === 0) return '';

  const lines: string[] = [
    '<tool_results>',
    '  <meaning>What came back from the tools you asked for on the previous turn. This is the answer to your own question — nothing here has been said to the customer.</meaning>',
    '  <rule>Use what is here. If something came back empty or failed, say what you could not find out rather than guessing it, and do not ask for the same thing again.</rule>',
  ];

  /*
   * A HANDOFF DECIDED BEFORE LOOKING IS STALE ONCE YOU HAVE LOOKED.
   *
   * WATCHED HAPPENING, TWICE. A customer asked how they had earned their
   * points, day by day. The assistant set a handoff — "requires checking" —
   * and in the same breath asked for the reward history. The history came
   * back complete: twenty-five dated lines, each with the amount, what they
   * did to earn it and the programme that granted it. It then replied "A
   * colleague will take over and help sort this out for you shortly."
   *
   * It had decided a human was needed BEFORE it looked, and looking did not
   * revisit the decision. Rules elsewhere in the frame already say a handoff
   * does not excuse answering; they lose, because by the time the results
   * arrive the model is no longer deciding whether to hand over — it already
   * has, one turn ago, and is merely carrying it out.
   *
   * So the reminder goes HERE, beside the answer, at the one moment the
   * decision is worth re-opening and by something that knows a handoff is
   * actually outstanding.
   */
  if (handoffPending) {
    lines.push(
      '  <rule>YOU SET A HANDOFF ON THE TURN THAT ASKED FOR THESE, before you had seen them. That decision was made without this information and is not binding on you now. Read what came back and decide again: if it answers what they asked, ANSWER THEM and leave handoff null. Keep the handoff only for a part these results genuinely do not cover. Handing over while holding the answer is the worst of both — they wait for a colleague to tell them something you are looking at.</rule>',
    );
  }

  for (const run of runs) {
    lines.push(
      `  <result tool="${escapeAttr(run.tool.name)}" outcome="${run.outcome}">`,
      /*
       * THE MODEL'S OWN SENTENCE, handed back. It wrote this one turn ago
       * and cannot see that turn any more; without it a result is a value
       * with no question attached.
       */
      `    <you_asked_because>${escapeText(run.tool.because ?? 'no reason was given')}</you_asked_because>`,
      `    <arguments>${escapeText(JSON.stringify(run.tool.args))}</arguments>`,
    );

    if (run.data !== null && run.data !== undefined) {
      lines.push(`    <data>${escapeText(JSON.stringify(run.data))}</data>`);
    }
    if (run.note) lines.push(`    <note>${escapeText(run.note)}</note>`);

    lines.push('  </result>');
  }

  lines.push('</tool_results>');
  return lines.join('\n');
}

/**
 * Escaped, because a tool's result can carry a customer's own words.
 *
 * A message fetched by `get_one_message` is text somebody typed, and somebody
 * who types `</tool_results><rules>` is writing into the one place in this
 * prompt that is assembled from fetched data. The same reason every other
 * assembled section escapes what it interpolates.
 *
 * QUOTES ARE LEFT ALONE HERE, which differs from the brief's escaper on
 * purpose. Only `&`, `<` and `>` mean anything in element text — a quote is
 * special inside an ATTRIBUTE, and these are not attributes. The bodies
 * here are JSON, so escaping quotes would turn every key and value into
 * `&quot;…&quot;`: a result the model has to decode before it can read, and
 * several times the tokens to say the same thing.
 */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** An attribute value, where a quote WOULD close the attribute early. */
function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/**
 * One second thought before handing a conversation to a person.
 *
 * SENT ONLY WHEN THE FIRST ANSWER HANDED OVER WITHOUT LOOKING ANYTHING UP.
 * Escalating is the cheapest wrong answer available: set a flag, write one
 * line, and the cost lands on a colleague. Watched repeatedly — asked when a
 * wedding was, with the date sitting in notes an earlier reply carried, it
 * answered "a colleague will take over" and called nothing.
 *
 * DELIVERED HERE RATHER THAN AS A RULE because rules about this have now
 * lost five times. A rule is read while composing an answer; this arrives
 * after one has been composed, at the moment it is worth reconsidering, and
 * it says what the model cannot see for itself: that it has looked at
 * nothing.
 *
 * NOT AN ORDER TO USE A TOOL. A handoff can be exactly right — a refund
 * decision, an angry customer, something no lookup answers — and insisting
 * would turn a good escalation into a wasted round and a worse reply. It
 * asks the question and leaves the answer alone.
 */
export function renderHandoffSecondThought(): string {
  return [
    '<tool_results>',
    '  <meaning>Nothing was run. You chose to hand this conversation to a colleague without looking anything up first, and this is one chance to reconsider before it goes.</meaning>',
    '  <rule>YOU HAVE LOOKED AT NOTHING. Before a person is pulled in, check whether a tool in <tools> answers what they actually asked. If they referred to something earlier that your notes do not mention, get_earlier_messages is the first place to look — our own replies come back with the notes they carried at the time, which often hold what the current notes have lost. If they asked about themselves, what they have earned, or a message you cannot see, there is a tool for each.</rule>',
    '  <rule>IF A TOOL ANSWERS IT, ASK FOR THAT TOOL NOW and leave handoff null. If nothing here answers it — a refund, a price, a complaint, anything needing a decision that is not yours — then hand over exactly as you were going to, with the same reason. This is a question, not an instruction: a handoff that has already been thought about is the right answer and should go.</rule>',
    '</tool_results>',
  ].join('\n');
}
