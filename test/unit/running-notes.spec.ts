import { describe, expect, it } from 'vitest';
import { reconcileNotes } from '@/modules/inbox/running-notes';

/**
 * Which running notes survive a reply.
 *
 * FROM A LIVE FAILURE ON gpt-6-luna. Handed 5,250 characters of notes
 * carrying 62 message ids, it returned 504 characters carrying one. The
 * wedding, the recorded name, the phone number and the handoff history all
 * went in a single turn — and the very next reply asked a question it had
 * asked eight seconds earlier, because it no longer knew it had.
 *
 * THE TEST IS THE ANCHORS, NOT THE LENGTH, and that is the whole design.
 * Compaction is legitimate and a growing conversation will need it, so the
 * model may rewrite the prose as tightly as it likes. What it may not do is
 * drop the ids, because those are what every entry is tied to.
 */
const id = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const notesOf = (count: number) =>
  Array.from({ length: count }, (_, i) => `id ${id(i % 10)} — a thing that happened.`).join(' ');

describe('keeping the running notes', () => {
  it('takes the new notes when they keep the anchors', () => {
    const previous = `id ${id(1)} — they asked. id ${id(2)} — we answered.`;
    const next = `id ${id(1)} — they asked. id ${id(2)} — we answered. id ${id(3)} — more.`;

    expect(reconcileNotes(previous, next).notes).toBe(next);
  });

  it('allows a rewrite that is far shorter but keeps the ids', () => {
    /*
     * THE CASE A LENGTH FLOOR WOULD HAVE BLOCKED. The model should be able
     * to say the same things in fewer words as a conversation grows; that
     * is what a summary is for.
     */
    const previous = [1, 2, 3, 4, 5]
      .map((n) => `id ${id(n)} — a long and rather wordy account of something that happened.`)
      .join(' ');
    const next = [1, 2, 3, 4, 5].map((n) => `id ${id(n)} — happened.`).join(' ');

    const decision = reconcileNotes(previous, next);
    expect(decision.notes).toBe(next);
    expect(decision.collapsed).toBe(false);
    /* Half the characters, every anchor intact. The ids themselves are 36
     * characters each, so they set a floor on how short notes can get —
     * which is another reason length is the wrong thing to measure. */
    expect(next.length).toBeLessThan(previous.length / 1.9);
  });

  it('refuses the rewrite that threw nearly everything away', () => {
    // The live failure, in miniature: ten anchors in, one back.
    const previous = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
      .map((n) => `id ${id(n)} — something.`)
      .join(' ');
    const next = `id ${id(0)} — they asked about their account.`;

    const decision = reconcileNotes(previous, next);
    expect(decision.notes).toBe(previous);
    expect(decision.collapsed).toBe(true);
  });

  it('reports what it saw, so a model that keeps doing this can be counted', () => {
    const previous = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `id ${id(n)} — x.`).join(' ');

    expect(reconcileNotes(previous, `id ${id(0)} — x.`)).toMatchObject({
      idsBefore: 10,
      idsAfter: 1,
    });
  });

  it('allows dropping a few that were genuinely resolved', () => {
    // The contract permits removing an entry once it is resolved, answered
    // or superseded. A turn that settles two of ten is editing, not forgetting.
    const previous = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `id ${id(n)} — x.`).join(' ');
    const next = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `id ${id(n)} — x.`).join(' ');

    expect(reconcileNotes(previous, next).collapsed).toBe(false);
  });

  it('keeps what was there when a reply writes no notes at all', () => {
    // Also seen live: a reply that returned no summary whatsoever. Silence
    // is not a rewrite, and it must not read as one.
    const previous = `id ${id(1)} — they told us their name.`;

    expect(reconcileNotes(previous, null)).toMatchObject({ notes: previous, collapsed: true });
    expect(reconcileNotes(previous, '   ').notes).toBe(previous);
  });

  it('accepts the first notes of a conversation', () => {
    expect(reconcileNotes(null, `id ${id(1)} — they said hello.`)).toMatchObject({
      collapsed: false,
    });
  });

  it('accepts notes that never carried an id to protect', () => {
    expect(
      reconcileNotes('they asked about opening hours', 'they asked, we answered'),
    ).toMatchObject({ collapsed: false });
  });

  it('does not care how the ids are cased', () => {
    const previous = `id ${id(1).toUpperCase()} — a thing.`;
    const next = `id ${id(1)} — the same thing, said better.`;

    expect(reconcileNotes(previous, next).collapsed).toBe(false);
  });

  describe('putting back what a lookup recovered', () => {
    /*
     * WATCHED LIVE. Asked when a wedding was, it fetched an older reply,
     * read the notes that reply carried, and answered correctly — then
     * wrote notes keeping ONE of the sixty-two anchors it had just been
     * handed. The question was answered once and forgotten again.
     *
     * The tool result asks it in plain words to carry a recovery forward.
     * It does not. The service knows what came back, so it folds them in
     * rather than asking.
     */
    const previous = `id ${id(1)} — they asked.`;
    const recovered = `id ${id(7)} — they shared a wedding invitation for 30 November 2026. id ${id(8)} — we confirmed the venue.`;

    it('keeps an entry the reply dropped after recovering it', () => {
      const decision = reconcileNotes(previous, `id ${id(1)} — they asked again.`, [recovered]);

      expect(decision.notes).toContain('30 November 2026');
      expect(decision.notes).toContain('we confirmed the venue');
    });

    it('leaves the model’s own wording alone where it kept the entry', () => {
      // Its version of an entry it kept is better than an older copy.
      const next = `id ${id(1)} — they asked. id ${id(7)} — the wedding, in their words.`;
      const decision = reconcileNotes(previous, next, [recovered]);

      expect(decision.notes).toContain('the wedding, in their words');
      expect(decision.notes).not.toContain('they shared a wedding invitation');
    });

    it('adds nothing when the lookup recovered nothing', () => {
      const next = `id ${id(1)} — they asked again.`;

      expect(reconcileNotes(previous, next, []).notes).toBe(next);
    });

    it('does not resurrect anything when the notes collapsed', () => {
      // A collapse keeps the PREVIOUS notes untouched; appending to a set
      // that was refused would be editing something nobody wrote.
      const long = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `id ${id(n)} — x.`).join(' ');
      const decision = reconcileNotes(long, `id ${id(0)} — x.`, [recovered]);

      expect(decision.notes).toBe(long);
      expect(decision.collapsed).toBe(true);
    });

    it('is bounded, so a long recovery cannot grow the notes without end', () => {
      const many = Array.from(
        { length: 200 },
        (_, i) => `id ${('0000000' + i).slice(-8)}-0000-4000-8000-000000000000 — entry ${i}.`,
      ).join(' ');
      const decision = reconcileNotes(previous, `id ${id(1)} — they asked.`, [many]);

      const ids = (decision.notes ?? '').match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      );
      expect((ids ?? []).length).toBeLessThanOrEqual(81);
    });
  });

  it('stays quiet when there is nothing on either side', () => {
    expect(reconcileNotes(null, null)).toMatchObject({ notes: null, collapsed: false });
  });

  it('survives a hundred entries without choking', () => {
    const previous = notesOf(100);
    expect(reconcileNotes(previous, previous).collapsed).toBe(false);
  });
});
