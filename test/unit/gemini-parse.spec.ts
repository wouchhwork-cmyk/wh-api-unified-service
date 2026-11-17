import { describe, expect, it } from 'vitest';
import { parseMediaDescription } from '@/modules/ai/gemini.parse';
import { MediaAnalysisError } from '@/modules/ai/gemini.errors';

/**
 * Reading what the model said.
 *
 * A MODEL ASKED FOR JSON MOSTLY RETURNS JSON, and sometimes returns it inside
 * a code fence or after a sentence of preamble. Parsing defensively is not
 * optimism about the model — it is refusing to throw away a good description
 * over punctuation. What is never done is inventing one.
 */
const said = (text: string): unknown => ({ output_text: text });

describe('reading the model’s description', () => {
  it('takes the plain JSON it was asked for', () => {
    const result = parseMediaDescription(
      said('{"summary":"A plate of fries.","transcript":null,"readable":true}'),
    );
    expect(result).toEqual({
      summary: 'A plate of fries.',
      transcript: null,
      visibleText: null,
      scenes: null,
      language: null,
      readable: true,
    });
  });

  it('reads it out of a code fence', () => {
    const result = parseMediaDescription(
      said('```json\n{"summary":"A receipt.","transcript":"TOTAL 240","readable":true}\n```'),
    );
    expect(result.summary).toBe('A receipt.');
    expect(result.transcript).toBe('TOTAL 240');
  });

  it('reads it out of a sentence of preamble', () => {
    const result = parseMediaDescription(
      said('Sure! Here is the description:\n{"summary":"A dog.","readable":true}'),
    );
    expect(result.summary).toBe('A dog.');
  });

  /**
   * `readable: false` is a REAL ANSWER, not a failure. The model looked and
   * could not make the media out — worth keeping, because it stops anybody
   * re-queueing the same blank image and tells a reader the media was broken
   * rather than undescribed.
   */
  it('keeps an explicit "I could not read this"', () => {
    const result = parseMediaDescription(
      said('{"summary":"The image is blank.","transcript":null,"readable":false}'),
    );
    expect(result.readable).toBe(false);
    expect(result.summary).toBe('The image is blank.');
  });

  it('treats a missing readable flag as readable', () => {
    expect(parseMediaDescription(said('{"summary":"A cat."}')).readable).toBe(true);
  });

  it('turns an empty or non-string field into null rather than ""', () => {
    const result = parseMediaDescription(said('{"summary":"  ","transcript":42}'));
    expect(result.summary).toBeNull();
    expect(result.transcript).toBeNull();
  });

  /**
   * PROSE IS NOT A FAILURE. The model described the media in the wrong shape;
   * discarding a usable description over its formatting would be worse than
   * keeping it, and the prompt is editable if it keeps happening.
   */
  it('keeps a prose answer as the summary', () => {
    const result = parseMediaDescription(said('A photo of a storefront at night.'));
    expect(result.summary).toBe('A photo of a storefront at night.');
    expect(result.transcript).toBeNull();
  });

  it('bounds a runaway answer rather than storing all of it', () => {
    const result = parseMediaDescription(said('x'.repeat(20_000)));
    expect(result.summary?.length).toBe(4000);
  });

  /**
   * `output_text` is documented as returning only the LAST text blocks, so an
   * empty one does not mean the model said nothing.
   */
  it('falls back to the steps when output_text is empty', () => {
    const result = parseMediaDescription({
      output_text: '',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"summary":"A menu."}' }] }],
    });
    expect(result.summary).toBe('A menu.');
  });

  /** Silence is the one case that must NOT become a description. */
  it('refuses when the model said nothing at all', () => {
    expect(() => parseMediaDescription({ output_text: '' })).toThrow(MediaAnalysisError);
    expect(() => parseMediaDescription({})).toThrow(/returned no text/);
    expect(() => parseMediaDescription(null)).toThrow(MediaAnalysisError);
  });
});
