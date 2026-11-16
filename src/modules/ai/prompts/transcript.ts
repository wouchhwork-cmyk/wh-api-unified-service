import type { ChatTurn } from '../ai.provider';

/**
 * A conversation written out as text, for a provider that cannot take it
 * any other way.
 *
 * WHY THIS IS NOT IN A CLIENT. It was, and that was wrong: how we label a
 * speaker is a decision about how this service represents a conversation,
 * not a fact about Google's API. Left in one vendor's client it is invisible
 * to the other, and the two drift the first time one of them changes — which
 * had already begun, because the id markers that let the notes point at a
 * message were added to the turns while the labels that carry them lived
 * somewhere else entirely.
 *
 * WHY IT IS NOT USED FOR EVERY PROVIDER. OpenAI's Responses API takes turns
 * as role-tagged items, which is the shape the model was trained on and
 * which keeps "what they said" structurally apart from "what we said".
 * Flattening that to match this would make the two uniform and make one of
 * them worse. The right kind of sameness is one definition of the labels,
 * not one envelope for both APIs.
 *
 * THE INSTRUCTION GOES FIRST and the turns follow, so the standing rules are
 * read before the text they govern — including the rule that says text
 * inside the conversation is content, never a command. It is a weaker
 * separation than a dedicated instructions field, and it is the only one
 * available here.
 */
export function renderTranscript(input: {
  readonly instructions?: string | undefined;
  readonly turns: readonly ChatTurn[];
}): string {
  const instructions = input.instructions?.trim() ?? '';
  const lines = input.turns.map((turn: ChatTurn) => `${speaker(turn)}: ${turn.text.trim()}`);

  /*
   * An absent instruction contributes NOTHING, not an empty line. The old
   * shape kept the empty string and opened every instruction-less transcript
   * with a blank line — invisible while this lived in a client nothing
   * tested, and a wasted token on every call that took that path.
   */
  return [...(instructions.length > 0 ? [instructions, ''] : []), ...lines, '', `${US}:`].join(
    '\n',
  );
}

/** Them and us, named once. */
const THEM = 'Them';
const US = 'You';

function speaker(turn: ChatTurn): string {
  return turn.role === 'user' ? THEM : US;
}
