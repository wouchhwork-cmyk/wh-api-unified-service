import { describe, expect, it } from 'vitest';
import { notesOn, reactionOn, renderTurnText } from '@/modules/inbox/turn-text';
import { CHATBOT_MESSAGE_CHARS } from '@/shared/constants';

/**
 * One message, as the model reads it — and the reason this is one function.
 *
 * The assistant builds its prompt from the thread; the replay rebuilds the
 * same prompt from the ids the call recorded. Those were two copies of this
 * logic and they had drifted three ways: the replay rendered the body and
 * the media, and silently dropped the reaction, the notes and the marker
 * saying what a message answers.
 *
 * That is wrong in two directions at once. Somebody opening "why did it say
 * this?" was shown a prompt the model never saw, missing the assistant's own
 * notes — the most useful thing on the page. And the fingerprint is taken
 * over this text, so every reply in a thread with notes reported as drifted,
 * which teaches everybody to ignore the one signal that says a replay cannot
 * be trusted.
 */
describe('rendering one turn', () => {
  it('starts with what was actually typed', () => {
    expect(renderTurnText({ body: '  are you open?  ' }, [])).toBe('are you open?');
  });

  it('folds in a description of media nobody can open any more', () => {
    const text = renderTurnText({ body: 'what is this?' }, [
      { summary: 'a wedding invitation', transcript: 'instrumental shehnai' },
    ]);
    expect(text).toContain('what is this?');
    expect(text).toContain('[media: a wedding invitation');
    expect(text).toContain('heard: instrumental shehnai');
  });

  it('keeps what was HEARD apart from what was READ', () => {
    /*
     * THE DISTINCTION THIS EXISTS FOR. These were joined with an em dash
     * into one run of text, so a wedding invitation's printed date sat in
     * the same breath as its background music — and whatever read it could
     * not tell whether the date was SAID to us or PRINTED on a card. Those
     * are different claims that lead to different replies, and only one of
     * them was true.
     */
    const text = renderTurnText({ body: 'when is it?' }, [
      {
        summary: 'a wedding invitation video',
        transcript: 'main: instrumental shehnai',
        visibleText: 'Neha & Nagendra\n30th Nov, Darbhanga',
        scenes: '1. a couple under an arch | on screen: Save The Date | audio: shehnai',
      },
    ]);

    expect(text).toContain('heard: main: instrumental shehnai');
    expect(text).toContain('read: Neha & Nagendra');
    expect(text).toContain('scene by scene: 1. a couple under an arch');
    // Labelled, not merely ordered: a model reading "heard:" knows what kind
    // of evidence it is holding without being taught the convention.
    expect(text).not.toContain('shehnai — Neha');
  });

  it('leaves out the parts a still image has none of', () => {
    const text = renderTurnText({ body: 'look' }, [
      { summary: 'a photo of a cracked mug', transcript: null, visibleText: null, scenes: null },
    ]);
    expect(text).toBe('look\n[media: a photo of a cracked mug]');
  });

  it('renders a silent image that is all text without pretending it was heard', () => {
    const text = renderTurnText({ body: null }, [
      { summary: 'a receipt', transcript: null, visibleText: 'TOTAL 450' },
    ]);
    expect(text).toContain('read: TOTAL 450');
    expect(text).not.toContain('heard:');
  });

  it('keeps the whole description, because the link is already dead', () => {
    /*
     * A cut at four hundred characters lost a wedding invitation's date and
     * venue, which were the two things anybody would have asked about. The
     * description is the only record that survives the CDN link.
     */
    const long = 'd'.repeat(4_000);
    expect(renderTurnText({ body: 'hi' }, [{ summary: long, transcript: null }])).toContain(
      `[media: ${long}]`,
    );
  });

  it('renders media on its own when there was no text at all', () => {
    // Instagram omits `text` for a GIF or a sticker, so an empty body with an
    // attachment is the ordinary case, not an empty message.
    const text = renderTurnText({ body: null }, [{ summary: 'a cracked mug', transcript: null }]);
    expect(text).toBe('[media: a cracked mug]');
  });

  it('keeps a reaction, which is an answer without words', () => {
    const text = renderTurnText(
      { body: 'thanks!', metadata: { reaction: { emoji: '❤', name: 'love' } } },
      [],
    );
    expect(text).toContain('[reaction: ❤ love]');
  });

  it('keeps the notes the assistant wrote with its own message', () => {
    const text = renderTurnText(
      { body: 'two days', metadata: { assistant: { summary: 'they asked about delivery' } } },
      [],
    );
    expect(text).toContain('[notes: they asked about delivery]');
  });

  it('never truncates the notes, which are cumulative', () => {
    /*
     * The model rewrites its notes from the notes it is shown. Cutting them
     * on the way in deletes history from the next set just as surely as
     * cutting them on the way out — and nothing else still holds it.
     */
    const long = 'n'.repeat(5_000);
    const text = renderTurnText({ body: 'ok', metadata: { assistant: { summary: long } } }, []);
    expect(text).toContain(`[notes: ${long}]`);
  });

  it('still bounds one message’s own text, so a pasted essay cannot dominate', () => {
    const text = renderTurnText({ body: 'b'.repeat(CHATBOT_MESSAGE_CHARS + 500) }, []);
    expect(text.length).toBe(CHATBOT_MESSAGE_CHARS);
  });

  it('puts them in the order a reader expects: words, media, reaction, notes', () => {
    const text = renderTurnText(
      {
        body: 'look',
        metadata: { reaction: { emoji: '👍' }, assistant: { summary: 'the notes' } },
      },
      [{ summary: 'a photo', transcript: null }],
    );
    expect(text.split('\n')).toEqual([
      'look',
      '[media: a photo]',
      '[reaction: 👍]',
      '[notes: the notes]',
    ]);
  });

  it('is empty when there is genuinely nothing to show', () => {
    expect(renderTurnText({ body: '   ' }, [])).toBe('');
    expect(renderTurnText({ body: null, metadata: {} }, [])).toBe('');
  });
});

describe('reading a reaction off a message', () => {
  it('takes the emoji and the word when both are there', () => {
    expect(reactionOn({ body: null, metadata: { reaction: { emoji: '❤', name: 'love' } } })).toBe(
      '❤ love',
    );
  });

  it('drops the platform’s useless "other"', () => {
    expect(reactionOn({ body: null, metadata: { reaction: { emoji: '🎉', name: 'other' } } })).toBe(
      '🎉',
    );
  });

  it('is null when nothing reacted', () => {
    expect(reactionOn({ body: null, metadata: {} })).toBeNull();
    expect(reactionOn({ body: null })).toBeNull();
    expect(reactionOn({ body: null, metadata: { reaction: 'heart' } })).toBeNull();
    expect(reactionOn({ body: null, metadata: { reaction: { name: 'other' } } })).toBeNull();
  });
});

describe('reading the notes off a message', () => {
  it('finds them where the assistant wrote them', () => {
    expect(notesOn({ body: null, metadata: { assistant: { summary: '  the notes  ' } } })).toBe(
      'the notes',
    );
  });

  it('is null for a message nothing summarised', () => {
    expect(notesOn({ body: null, metadata: {} })).toBeNull();
    // A holding line carries assistant metadata and no summary — it wrote
    // nothing down, because no model saw it.
    expect(notesOn({ body: null, metadata: { assistant: { hold: true } } })).toBeNull();
    expect(notesOn({ body: null, metadata: { assistant: { summary: '   ' } } })).toBeNull();
  });
});
