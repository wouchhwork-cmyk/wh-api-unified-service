import { createHash } from 'node:crypto';
import type { ChatTurn } from '../ai.provider';
import { renderTranscript } from './transcript';

/**
 * The marker that names which message a turn came from.
 *
 * DEFINED AND READ IN ONE PLACE, for the same reason the output contract is:
 * the format is written when a turn is built and read when a prompt is
 * reconstructed or a reply is stripped, and three copies of a regular
 * expression is how those quietly stop agreeing.
 */
const TURN_ID = /^\[id:([^\]\s]{1,64})(?:[^\]]*)\]\s*/;

/** What else is worth saying about a message besides its words. */
export interface TurnMeta {
  /** How it arrived: a photo, a voice note, a reply to a story. */
  readonly kind?: string | undefined;
  /** The message it answers, by public id, when it answers one. */
  readonly replyTo?: string | null | undefined;
}

/**
 * A turn, tagged with the message it came from and how it got here.
 *
 * `kind` IS OMITTED WHEN IT IS PLAIN TEXT, which is nearly every turn. The
 * marker is paid for on every message of every call, and `kind:text` says
 * nothing a model could not already tell by reading it. What earns its place
 * is the unusual: a voice note, a sticker, a reply to a story.
 *
 * `re` NAMES A MESSAGE RATHER THAN DESCRIBING ONE, so the model can follow a
 * reply back to what it answered — which on a threaded platform is the
 * difference between "yes" meaning agreement and "yes" meaning an answer to
 * a question four messages ago.
 */
export function tagTurn(refId: string, text: string, meta: TurnMeta = {}): string {
  const parts = [`id:${refId}`];
  if (meta.kind && meta.kind !== PLAIN) parts.push(`kind:${meta.kind}`);
  if (meta.replyTo) parts.push(`re:${meta.replyTo}`);
  return `[${parts.join(' ')}] ${text}`;
}

/** The kind that needs no saying. */
const PLAIN = 'text';

/** Which messages a set of turns was built from, in order. */
export function turnIdsOf(turns: readonly ChatTurn[]): string[] {
  return turns
    .map((turn) => TURN_ID.exec(turn.text)?.[1])
    .filter((id): id is string => id !== undefined);
}

/**
 * The prompt as one canonical string, whatever shape it was sent in.
 *
 * PROVIDER-INDEPENDENT ON PURPOSE. OpenAI takes role-tagged items and an
 * instructions field; Gemini takes one flattened text part. Fingerprinting
 * what each client happened to send would make two identical prompts hash
 * differently, which defeats the only question worth asking of a hash — is
 * this the same prompt as that one. So both are rendered the same way, which
 * is also exactly the text a person is shown when they ask to see it.
 */
export function canonicalPrompt(input: {
  readonly instructions?: string | undefined;
  readonly turns: readonly ChatTurn[];
}): string {
  return renderTranscript(input);
}

/**
 * A prompt, as 64 characters instead of several kilobytes of somebody's
 * conversation.
 *
 * This is what makes a reconstruction falsifiable. Rebuilding gives the
 * prompt as it would be built NOW; comparing this says whether that is still
 * what ran. Equal means exact. Different means something underneath moved —
 * a profile edited, a photo described again, a console prompt rewritten —
 * and what you are looking at is a lead rather than evidence.
 */
export function fingerprint(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}
