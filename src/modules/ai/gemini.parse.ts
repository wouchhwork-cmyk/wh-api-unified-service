import { MediaAnalysisError, MediaFailure } from './gemini.errors';
import type { MediaDescription } from './gemini.client';
import { readMediaDescription } from './prompts';

/**
 * The model's answer, which is TEXT THAT CLAIMS TO BE JSON.
 *
 * THE SHAPE IS NOT DESCRIBED HERE ANY MORE. It is declared once beside the
 * instruction that asks for it, so a field cannot be read here without
 * appearing there — which is the whole reason the prompt stopped being a
 * free-text box staff could quietly delete the contract out of.
 *
 * What stays here is the decision about an answer that does not fit:
 * prose is KEPT AS THE SUMMARY rather than discarded, because a usable
 * description in the wrong envelope is still a usable description, and the
 * prompt is editable, so a model that keeps doing it is a prompt to fix. An
 * empty answer is not tolerated — that one raises, and the ledger records
 * that the model answered unusably.
 */
export function parseMediaDescription(raw: unknown): MediaDescription {
  const text = outputTextOf(raw);
  if (!text) {
    throw new MediaAnalysisError(MediaFailure.ModelUnparsable, 'the model returned no text', false);
  }

  const described = readMediaDescription(text);
  if (described) return described;

  return {
    summary: text.trim().slice(0, 4000),
    transcript: null,
    visibleText: null,
    scenes: null,
    language: null,
    readable: true,
  };
}

export function outputTextOf(raw: unknown): string | null {
  const row = raw as { output_text?: unknown; steps?: unknown } | null;
  if (typeof row?.output_text === 'string' && row.output_text.trim().length > 0) {
    return row.output_text;
  }
  /*
   * `output_text` is an SDK convenience that returns only the LAST text blocks,
   * and is documented as skipping earlier ones separated by non-text content.
   * The steps are the authority when it comes back empty.
   */
  if (!Array.isArray(row?.steps)) return null;
  const parts: string[] = [];
  for (const step of row.steps as { content?: unknown }[]) {
    if (!Array.isArray(step?.content)) continue;
    for (const part of step.content as { type?: unknown; text?: unknown }[]) {
      if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  const joined = parts.join('\n').trim();
  return joined.length > 0 ? joined : null;
}
