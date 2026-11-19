/**
 * The shape we ask a model for, declared ONCE.
 *
 * WHY THIS EXISTS. The instruction that tells a model what to return and the
 * code that reads what came back are the same decision written twice, and
 * until now the first half lived in a prompt staff can edit. Somebody
 * reformatting the media prompt could drop the `## Output` block without
 * touching a line of code, and nothing would fail loudly: the parser would
 * quietly take the model's prose as a summary, a transcript would stop being
 * recorded, and the first sign of it would be a thread that had forgotten
 * what a customer said in a voice note.
 *
 * So the shape moves into code and the prompt text is GENERATED from it. A
 * field cannot be added to the reader without appearing in the instruction,
 * and cannot be removed from the instruction while the reader still expects
 * it. The console keeps the half that is genuinely a matter of taste — what
 * to look for, how to speak — and gives up the half that is a contract.
 */

/** What a field may hold, written exactly as the model is told it. */
export const FieldKind = {
  Text: 'string',
  OptionalText: 'string | null',
  Flag: 'boolean',
  /**
   * A nested object, or null.
   *
   * ADDED FOR TOOL CALLS, where the arguments are a shape of their own and
   * every alternative is worse. A JSON string inside a JSON string makes a
   * model escape quotes twice and it gets the second level wrong often
   * enough to matter; a flat prefix per argument turns every new tool into a
   * contract change. This keeps the asking and the reading in one place,
   * which is the whole reason this file exists.
   *
   * Passed through UNVALIDATED by `readContract` on purpose: what belongs
   * inside depends on which tool was named, and that is a decision the
   * registry makes with the tool's own shape in hand.
   */
  Json: 'object | null',
  /**
   * A whole number, or null.
   *
   * Added for tool arguments that are counts — "how many messages either
   * side of this one". Declared rather than taken as text because the
   * BOUNDS are the point: a count a model picks is a count that can be 500,
   * and the difference between asking for text and asking for a number is
   * where that gets caught.
   */
  Count: 'number | null',
} as const;

export type FieldKind = (typeof FieldKind)[keyof typeof FieldKind];

export interface ContractField {
  readonly kind: FieldKind;
  /**
   * One line under the shape saying what belongs in it.
   *
   * Not decoration: a bare `{"language": string | null}` gets the language of
   * the prompt about as often as the language of the media.
   */
  readonly note: string;
  /**
   * What a missing flag means.
   *
   * Only flags need it, and only because absence is an answer for them: a
   * model that forgot to say whether the media was readable described
   * something, so `readable` missing means readable. A missing string is just
   * missing.
   */
  readonly whenMissing?: boolean;
}

export type ContractShape = Readonly<Record<string, ContractField>>;

/** A read of one answer: every declared field, typed by the kind declared. */
export type ContractValues<S extends ContractShape> = {
  readonly [K in keyof S]: S[K]['kind'] extends typeof FieldKind.Flag
    ? boolean
    : S[K]['kind'] extends typeof FieldKind.Json
      ? Record<string, unknown> | null
      : S[K]['kind'] extends typeof FieldKind.Count
        ? number | null
        : string | null;
};

/**
 * The `<output>` section, written from the shape.
 *
 * XML RATHER THAN PROSE HEADINGS. A model reads a tagged block as a boundary
 * it should not cross — the shape stops being advice buried in a paragraph
 * and becomes a thing with edges — and when something does come back wrong,
 * a tag is searchable in a log in a way "the bit after the heading" is not.
 *
 * The shape line comes first because that is what gets copied, and each
 * field is its own element because that is what gets read. Declaring the
 * type twice, once in the shape and once on the element, is not redundant to
 * a model skimming one or the other.
 */
export function renderOutputSection(shape: ContractShape): string {
  const inline = Object.entries(shape)
    .map(([name, field]) => `"${name}": ${field.kind}`)
    .join(', ');
  const fields = Object.entries(shape).map(
    ([name, field]) => `  <field name="${name}" type="${field.kind}">${field.note}</field>`,
  );

  return [
    '<output format="json">',
    `  <shape>{${inline}}</shape>`,
    ...fields,
    '  <rule>Reply with that one JSON object and nothing else: no prose before or after it, no code fence, no explanation.</rule>',
    '  <rule>Every key must be present. Use null rather than omitting a key or inventing a value.</rule>',
    '</output>',
  ].join('\n');
}

/**
 * The answer, read back against the same shape.
 *
 * DEFENSIVE, NOT OPTIMISTIC. A model asked for JSON mostly returns JSON and
 * sometimes returns it inside a fence or behind a sentence, and throwing away
 * a good description over punctuation would be its own kind of bug. What this
 * will NOT do is invent: a body with no object in it at all returns null, and
 * the caller decides whether that is a failure or a thing to fall back from.
 *
 * Unknown keys are ignored and missing ones come back null, so adding a field
 * to the shape cannot break the reading of an answer written before it
 * existed — which matters because descriptions outlive the prompt that
 * produced them.
 */
export function readContract<S extends ContractShape>(
  shape: S,
  text: string,
): ContractValues<S> | null {
  const object = objectIn(text);
  if (!object) return null;

  const values: Record<string, string | boolean | number | Record<string, unknown> | null> = {};
  for (const [name, field] of Object.entries(shape)) {
    const raw = object[name];
    if (field.kind === FieldKind.Flag) {
      values[name] = typeof raw === 'boolean' ? raw : (field.whenMissing ?? true);
      continue;
    }
    if (field.kind === FieldKind.Json) {
      values[name] = objectOrNull(raw);
      continue;
    }
    if (field.kind === FieldKind.Count) {
      values[name] = countOrNull(raw);
      continue;
    }
    values[name] = textOrNull(raw);
  }
  return values as ContractValues<S>;
}

/**
 * The first JSON object in a body of text.
 *
 * Outermost braces rather than a strict parse of the whole string, because
 * the whole string is frequently not JSON — it is JSON with an apology in
 * front of it.
 */
function objectIn(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A nested object, or null for anything else.
 *
 * An ARRAY is not an object here. A model handed "an object or null" will
 * occasionally send `[]`, and `typeof [] === 'object'` would let it through
 * to a caller reading named keys off it — which finds nothing and reports no
 * arguments rather than a malformed answer.
 */
function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A whole number, or null.
 *
 * A NUMERIC STRING COUNTS. Asked for a number a model will send `"3"` often
 * enough that refusing it would be refusing a correct answer over quoting.
 * Anything that is not finite is null rather than NaN, which would survive
 * every comparison downstream and fail none of them.
 */
function countOrNull(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
