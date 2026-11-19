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
  /**
   * The colleague who typed it, when a person did.
   *
   * ONLY AN OUTBOUND MESSAGE HAS ONE, and it is how a reply a human wrote
   * is told apart from a reply the assistant wrote. See `whoSentIt`.
   */
  readonly sentByEmployeeId?: number | null | undefined;
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

  /*
   * WHAT THE SYSTEM DID WITHOUT ASKING, on the message it did it with.
   *
   * An automatic apology or a holding line goes out over the assistant's
   * own name, so on the next turn it reads as one of its own replies. This
   * says plainly that it was not.
   */
  const automatic = systemNoteOn(message);
  if (automatic) parts.push(`[automatic: ${automatic}]`);

  /* WHO ACTUALLY TYPED IT. See `whoSentIt` — without this a colleague's
   * words arrive under the assistant's own name. */
  const person = whoSentIt(message);
  if (person) parts.push(`[by: ${person}]`);

  /* WHERE THE ESCALATION HAPPENED, so the sequence can be read. */
  const escalated = handoffOn(message);
  if (escalated) {
    parts.push(
      `[handoff raised at this point: ${escalated} — check <colleague_requested> for whether anybody is still waiting; if nobody is, this was dealt with after this message.]`,
    );
  }

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

/**
 * Why an automatic apology is sitting in the thread.
 *
 * WITHOUT THIS THE ASSISTANT READS ITS OWN FALLBACK AS SOMETHING IT CHOSE.
 * When a model call fails outright the service sends "Sorry, I have to step
 * away for something urgent" over the assistant's name — and on the next
 * turn that line is just another of its messages in the window. It has been
 * seen building on exactly that kind of sentence: treating a thing the
 * system did as a decision it made, and carrying it forward.
 *
 * So the turn says what it actually was. The customer never sees this; it is
 * rendered into the window the model reads.
 */
export function systemNoteOn(message: TurnSource): string | null {
  const assistant = (message.metadata as { assistant?: unknown } | undefined)?.assistant;
  if (!assistant || typeof assistant !== 'object') return null;

  if ((assistant as { fallback?: unknown }).fallback === true) {
    return (
      'this message was sent AUTOMATICALLY by the system because a model call failed — ' +
      'you did not choose it, you did not step away, and nothing was looked at. ' +
      'A colleague has been asked to pick this up. Do not treat it as something you ' +
      'decided or refer back to it as if you had.'
    );
  }
  if ((assistant as { hold?: unknown }).hold === true) {
    return (
      'this was a holding line sent while media was still being described. The ' +
      'description below arrived afterwards, so answer from it rather than apologising again.'
    );
  }
  return null;
}

/**
 * The moment a reply escalated, marked on the reply that did it.
 *
 * SO THE SEQUENCE IS READABLE. The frame says whether anybody is waiting
 * for a person RIGHT NOW, and the window shows whether a colleague has
 * spoken — but nothing said where the escalation happened, so "a handoff
 * was raised here and has since been closed" could not be reconstructed
 * from either. The assistant kept announcing a colleague was coming long
 * after one had come and gone, because from where it sat those were three
 * unrelated facts rather than one story.
 *
 * Reading it with <colleague_requested> completes it: raised at this point
 * in the conversation, and — if nobody is pending now — dealt with since.
 */
export function handoffOn(message: TurnSource): string | null {
  const assistant = (message.metadata as { assistant?: unknown } | undefined)?.assistant;
  if (!assistant || typeof assistant !== 'object') return null;

  const handoff = (assistant as { handoff?: unknown }).handoff;
  return typeof handoff === 'string' && handoff.trim().length > 0 ? handoff.trim() : null;
}

/**
 * Said by a colleague, not by the assistant.
 *
 * WITHOUT THIS EVERY OUTBOUND MESSAGE READS AS "You:". A colleague typing
 * in the portal, a colleague answering from the Instagram app, and the
 * assistant's own replies all arrive in the window under the same label —
 * so the assistant reads a human's words as its own and builds on them.
 *
 * Watched live. A colleague typed "The ai tool will help you out, give it
 * some time to think" and then marked the handoff as handled. The assistant
 * saw its own name against that sentence, had no idea a person had been and
 * gone, and went on telling the customer a colleague was still on the way.
 * Both halves of what actually happened — somebody came, somebody finished
 * — were invisible to it.
 *
 * A COLLEAGUE'S MESSAGE IS ALSO EVIDENCE THE HANDOFF WAS WORKED. That is
 * worth saying out loud, because it is the thing the assistant most needs
 * to stop repeating.
 */
export function whoSentIt(message: TurnSource): string | null {
  const byPerson = message.sentByEmployeeId !== null && message.sentByEmployeeId !== undefined;
  if (!byPerson) return null;

  const assistant = (message.metadata as { assistant?: unknown } | undefined)?.assistant;
  /* Belt and braces: a reply the assistant wrote carries its own block, and
   * nothing should ever have both. If something does, it was the assistant. */
  if (assistant && typeof assistant === 'object') return null;

  return (
    'a COLLEAGUE at this business typed this, not you. Somebody human has been in ' +
    'this conversation — do not treat it as something you said, do not repeat it ' +
    'back as your own, and do not tell them a colleague is still coming when one ' +
    'has plainly already been here.'
  );
}

/** The summary this reply was sent with, when it carried one. */
export function notesOn(message: TurnSource): string | null {
  const assistant = (message.metadata as { assistant?: unknown } | undefined)?.assistant;
  if (!assistant || typeof assistant !== 'object') return null;

  const summary = (assistant as { summary?: unknown }).summary;
  return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : null;
}
