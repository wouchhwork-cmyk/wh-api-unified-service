import { CHATBOT_MESSAGE_CHARS } from '@/shared/constants';

/**
 * ONE RENDERER FOR ONE MESSAGE, used by the live reply and by the replay.
 *
 * WHY THIS IS SHARED RATHER THAN WRITTEN TWICE. The assistant builds its
 * prompt from the thread, and the replay rebuilds the same prompt from the
 * ids the call recorded. Those were two copies of this logic, and they had
 * already drifted three ways: the replay rendered the body and the media and
 * silently dropped the reaction, the notes and the `re:` marker that says
 * what a message answers.
 *
 * That is worse than it sounds, in two directions at once. A reader opening
 * "why did it say this?" was shown a prompt the model never saw, with the
 * assistant's own running notes missing from it — the single most useful
 * thing on the page. And the FINGERPRINT is taken over this text, so every
 * reply in a thread with notes or reactions reported as drifted, which
 * trains everybody to ignore the one signal that says a replay is not
 * trustworthy.
 *
 * Kept pure and narrow on purpose: it takes what it reads and nothing else,
 * so neither caller can hand it a thread and have it grow a query.
 */

/** What the renderer needs from a message, and nothing more. */
export interface TurnSource {
  readonly body: string | null;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** What it needs from a media description. */
export interface TurnMedia {
  readonly summary: string | null;
  /** Sound only: speech, lyrics, notable noise. */
  readonly transcript: string | null;
  /** Writing only: anything legible in the frame. */
  readonly visibleText?: string | null;
  /** A video shot by shot, tying picture to on-screen words to sound. */
  readonly scenes?: string | null;
}

/**
 * The message as the model should read it: what was typed, plus what was
 * sent that nobody can open any more.
 *
 * A photo whose CDN link expired is the ordinary case on this platform, and
 * its description is the only record that survives — so it is folded into
 * the text rather than left out, which is what makes "what did they send
 * me?" answerable six months later.
 */
export function renderTurnText(message: TurnSource, described: readonly TurnMedia[]): string {
  const parts: string[] = [];

  const body = message.body?.trim() ?? '';
  if (body.length > 0) parts.push(body.slice(0, CHATBOT_MESSAGE_CHARS));

  for (const analysis of described) {
    /*
     * HEARD, READ, AND SEEN — KEPT APART, because the reader has to be able
     * to tell them apart.
     *
     * These were joined with an em dash into one run of text, which put a
     * wedding invitation's printed date and venue in the same breath as its
     * background music. Whatever reads that cannot tell whether a date was
     * SAID to us or PRINTED on a card somebody sent, and those are different
     * claims leading to different replies — only one of which is true.
     *
     * Labelled rather than merely ordered: a model reading `heard:` knows
     * what kind of evidence it has without being told the convention.
     */
    const labelled: string[] = [];
    const push = (label: string, value: string | null | undefined): void => {
      const text = value?.trim() ?? '';
      if (text.length > 0) labelled.push(`${label}: ${text}`);
    };

    push('', analysis.summary);
    push('heard', analysis.transcript);
    push('read', analysis.visibleText);
    push('scene by scene', analysis.scenes);

    /*
     * WHOLE, NOT TRIMMED. The link died days ago, so these words are the
     * only record of what somebody sent — and they are in front of the model
     * precisely when it is being asked about them. A cut at four hundred
     * characters lost a wedding invitation's date and venue, which were the
     * two things anybody would have asked about.
     */
    const detail = labelled.join('\n  ').replace(/^: /, '');
    if (detail.length > 0) parts.push(`[media: ${detail}]`);
  }

  /*
   * A REACTION IS A REPLY WITHOUT WORDS, and it was being thrown away.
   *
   * Somebody who answers a message with a heart has responded — often
   * instead of typing — and a thread that drops it reads as though they went
   * quiet. It also changes what to say next: thanking somebody who already
   * said thanks with an emoji is the assistant talking past them.
   */
  const reaction = reactionOn(message);
  if (reaction) parts.push(`[reaction: ${reaction}]`);

  /*
   * THE NOTES WE WROTE AT THE TIME, on the message they were written with.
   *
   * The latest set is carried in <context> for everything before the window;
   * these are what each reply understood as it was sent, which is how the
   * model sees its own understanding change rather than only where it ended
   * up. Whole — they are cumulative, and a cut through the middle of one
   * loses history that nothing else still holds.
   */
  const notes = notesOn(message);
  if (notes) parts.push(`[notes: ${notes}]`);

  return parts.join('\n').trim();
}

/** What somebody reacted with, when they reacted rather than wrote. */
export function reactionOn(message: TurnSource): string | null {
  const reaction = (message.metadata as { reaction?: unknown } | undefined)?.reaction;
  if (!reaction || typeof reaction !== 'object') return null;

  const { emoji, name } = reaction as { emoji?: unknown; name?: unknown };
  const mark = typeof emoji === 'string' && emoji.length > 0 ? emoji : null;
  const word = typeof name === 'string' && name.length > 0 && name !== 'other' ? name : null;
  if (!mark && !word) return null;
  return [mark, word].filter((value) => value !== null).join(' ');
}

/** The summary this reply was sent with, when it carried one. */
export function notesOn(message: TurnSource): string | null {
  const assistant = (message.metadata as { assistant?: unknown } | undefined)?.assistant;
  if (!assistant || typeof assistant !== 'object') return null;

  const summary = (assistant as { summary?: unknown }).summary;
  return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : null;
}
