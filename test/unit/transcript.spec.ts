import { describe, expect, it } from 'vitest';
import { renderTranscript } from '@/modules/ai/prompts';

/**
 * How a conversation reads to a provider that cannot take roles.
 *
 * This lived inside the Gemini client until the id markers were added to the
 * turns and the labels that carry them turned out to be somewhere else
 * entirely — which is how two providers quietly stop seeing the same
 * conversation. It is one definition now, and testable for the first time.
 */
describe('writing a conversation out as text', () => {
  const turns = [
    { role: 'user' as const, text: '[id:a1] are you open?' },
    { role: 'assistant' as const, text: '[id:b2] yes, until nine' },
    { role: 'user' as const, text: '[id:c3] great' },
  ];

  it('keeps what they said apart from what we said', () => {
    const text = renderTranscript({ turns });

    expect(text).toContain('Them: [id:a1] are you open?');
    expect(text).toContain('You: [id:b2] yes, until nine');
  });

  it('puts the instruction before the text it governs', () => {
    const text = renderTranscript({ instructions: '<rules>be brief</rules>', turns });

    expect(text.indexOf('<rules>')).toBeLessThan(text.indexOf('Them:'));
  });

  it('ends on our turn, so the model knows whose line it is', () => {
    expect(renderTranscript({ turns }).trimEnd().endsWith('You:')).toBe(true);
  });

  it('carries the id markers through untouched', () => {
    /* They are how the notes point at a message. A renderer that dropped
     * them would leave the notes describing instead of citing. */
    const text = renderTranscript({ turns });

    expect(text).toContain('[id:a1]');
    expect(text).toContain('[id:c3]');
  });

  it('reads sensibly with no instruction at all', () => {
    const text = renderTranscript({ turns });

    expect(text.startsWith('Them:')).toBe(true);
    expect(text).not.toContain('\n\n\n');
  });

  it('writes an empty conversation without inventing a turn', () => {
    expect(renderTranscript({ turns: [] }).trim()).toBe('You:');
  });
});
