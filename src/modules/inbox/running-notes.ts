import { NOTES_MAX_RECOVERED_ENTRIES, NOTES_MIN_ID_RETENTION } from '@/shared/constants';

/** The message ids the notes are anchored on. */
const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface NotesDecision {
  /** What to actually store. The previous notes, when the new ones collapsed. */
  readonly notes: string | null;
  /** The new notes dropped so much that they were refused. */
  readonly collapsed: boolean;
  readonly idsBefore: number;
  readonly idsAfter: number;
}

/**
 * Decides which running notes to keep: the model's new ones, or the old.
 *
 * WHY THE SERVICE DECIDES THIS AT ALL. The notes are the only memory of a
 * conversation older than the handful of messages in the window — so a reply
 * that rewrites them badly does not lose a turn, it permanently deletes
 * history. Watched live on `gpt-6-luna`: handed 5,250 characters of notes
 * carrying 62 message ids, it returned 504 characters carrying one. Sixty-one
 * anchors gone in a single turn: the wedding, the recorded name, the phone
 * number, the handoff history. The very next reply then asked a question it
 * had asked eight seconds earlier, because it no longer knew it had.
 *
 * The prompt says they are cumulative, in capitals, with "anything you drop
 * is gone for good" spelled out. Gemini obeyed it and grew them steadily;
 * this model did not. An instruction that one provider honours and another
 * ignores is not a safeguard.
 *
 * WHY NOT A LENGTH FLOOR. Because COMPACTION IS LEGITIMATE and will become
 * necessary: as a conversation grows the model should be able to say the
 * same things in fewer words, and a rule that refuses anything shorter would
 * block the good version and the bad version alike.
 *
 * SO THE TEST IS THE ANCHORS, NOT THE PROSE. Every entry is tied to a
 * message id, and the contract already says an entry may go only once it is
 * "resolved, answered or superseded" — a few per turn, not sixty-one. Rework
 * the wording as much as you like; keep the ids. That distinguishes a model
 * tightening its notes from a model forgetting the conversation, which is
 * exactly the distinction length cannot make.
 *
 * REFUSING KEEPS THE OLD NOTES RATHER THAN MERGING. A merge would have to
 * guess which half of two overlapping accounts is current, and guessing
 * about memory is how the problem started. One turn's additions are lost;
 * the next reply is handed the full notes and gets another go. That is
 * recoverable. Sixty-one deleted anchors are not.
 */
export function reconcileNotes(
  previous: string | null | undefined,
  next: string | null | undefined,
  /**
   * Notes read back out of an older reply this turn, via get_one_message.
   *
   * MERGED BY THIS SERVICE RATHER THAN BY THE MODEL. The tool result tells
   * it in plain words to carry what it recovers into the notes it writes;
   * watched live, it used the recovered text to answer and then wrote notes
   * that kept one of the sixty-two anchors it had just been handed. It
   * answered that question correctly and forgot the answer again.
   *
   * We know exactly what came back, so there is nothing to ask for: the
   * entries whose anchors are missing from the new notes are appended. That
   * makes a recovery permanent whether or not the model cooperates, which
   * is the whole difference between answering once and remembering.
   */
  recovered: readonly string[] = [],
): NotesDecision {
  const before = new Set((previous ?? '').match(ID)?.map((id) => id.toLowerCase()) ?? []);
  const after = new Set((next ?? '').match(ID)?.map((id) => id.toLowerCase()) ?? []);
  const kept = [...before].filter((id) => after.has(id)).length;

  const counts = { idsBefore: before.size, idsAfter: after.size };

  /* Nothing written this turn. Silence is not a rewrite, but it must not
   * read as one either: keep what was there. */
  if (!next || next.trim().length === 0) {
    return previous && previous.trim().length > 0
      ? { notes: previous, collapsed: true, ...counts }
      : { notes: null, collapsed: false, ...counts };
  }

  /* Nothing to protect yet — the first notes of a conversation, or notes
   * that never carried an id to begin with. */
  if (before.size === 0) return { notes: next, collapsed: false, ...counts };

  const retention = kept / before.size;
  if (retention < NOTES_MIN_ID_RETENTION) {
    return { notes: previous ?? null, collapsed: true, ...counts };
  }

  return { notes: withRecovered(next, after, recovered), collapsed: false, ...counts };
}

/**
 * Puts back what was read out of an older reply and then dropped.
 *
 * ENTRY BY ENTRY, keyed on the anchor. The notes are sentences of the form
 * "id <uuid> — what happened", so an entry whose id the new notes do not
 * mention is something recovered this turn and not kept. Anything already
 * mentioned is left alone: the model's own wording for an entry it kept is
 * better than an older version of the same thing.
 *
 * BOUNDED, because a recovery can return a long history and appending all of
 * it every turn would grow the notes without end. The cap is generous enough
 * to carry a real recovery — the live one was sixty-two entries — and still
 * a cap.
 */
function withRecovered(
  next: string,
  /* Mutated as entries are taken, so two recovered sets cannot both
   * contribute the same anchor. */
  haveIds: Set<string>,
  recovered: readonly string[],
): string {
  if (recovered.length === 0) return next;

  const entries: string[] = [];
  for (const text of recovered) {
    /* Split on the sentence boundary that precedes an anchored entry, which
     * is how these are written and how they are read back. */
    for (const entry of text.split(/(?<=\.)\s+(?=id )/)) {
      const ids = entry.match(ID)?.map((id) => id.toLowerCase()) ?? [];
      if (ids.length === 0) continue;
      if (ids.some((id) => haveIds.has(id))) continue;
      entries.push(entry.trim());
      ids.forEach((id) => haveIds.add(id));
      if (entries.length >= NOTES_MAX_RECOVERED_ENTRIES) break;
    }
    if (entries.length >= NOTES_MAX_RECOVERED_ENTRIES) break;
  }

  if (entries.length === 0) return next;
  return `${next.trim()} ${entries.join(' ')}`.trim();
}
