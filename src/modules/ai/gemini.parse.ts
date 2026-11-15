import { MediaAnalysisError, MediaFailure } from './gemini.errors';
import type { MediaDescription } from './gemini.client';

/**
 * The model's answer, which is TEXT THAT CLAIMS TO BE JSON.
 *
 * A model asked for JSON mostly returns JSON, and sometimes returns it
 * wrapped in a code fence or with a sentence in front. Parsing defensively
 * is not optimism about the model — it is refusing to throw away a good
 * answer over punctuation. What is NOT done is inventing a description when
 * parsing fails: that path raises, and the ledger records that the model
 * answered unusably.
 */
export function parseMediaDescription(raw: unknown): MediaDescription {
  const text = outputTextOf(raw);
  if (!text) {
    throw new MediaAnalysisError(MediaFailure.ModelUnparsable, 'the model returned no text', false);
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');

  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') {
        const row = parsed as Record<string, unknown>;
        return {
          summary: textOrNull(row.summary),
          transcript: textOrNull(row.transcript),
          readable: row.readable !== false,
        };
      }
    } catch {
      /* Falls through to the plain-text reading below, deliberately. */
    }
  }

  /*
   * NOT JSON, BUT NOT NOTHING. The model described the media in prose
   * instead of the shape asked for. Keeping it as the summary is better than
   * discarding a usable description over its formatting — and the prompt is
   * editable, so a model that keeps doing this is a prompt to fix.
   */
  return { summary: candidate.slice(0, 4000), transcript: null, readable: true };
}

function outputTextOf(raw: unknown): string | null {
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

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
