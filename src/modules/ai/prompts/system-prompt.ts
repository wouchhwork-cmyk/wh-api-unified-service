/**
 * How the pieces of an instruction are stacked, and in what order.
 *
 * THERE ARE TWO AUTHORS AND THEY ARE NOT EQUALS.
 *
 * One is the console: a person writing how their business should sound, what
 * it will and will not promise, which details matter. That is theirs, it
 * changes without a deploy, and it is the reason the prompt is a row rather
 * than a constant.
 *
 * The other is this service, which has to READ the answer and ACT on it. The
 * output shape, the field that decides whether a message is sent at all, the
 * rule that text arriving from a stranger is content rather than command —
 * none of those are matters of taste. A console that could edit them is a
 * console where a well-meaning rewrite silently turns off the parser, or
 * hands a customer a raw brace.
 *
 * So the two are stacked rather than concatenated, each inside its own tag:
 *
 *   <role>                  what this call is            (ours)
 *   <rules>                 what must always hold        (ours)
 *   <business_instructions> how this business sounds     (theirs)
 *   <context>               the facts for this one call  (ours, assembled)
 *   <output>                the shape we will read back  (ours)
 *
 * TAGS RATHER THAN HEADINGS. The business section is the only one written by
 * somebody outside this repository, and it can contain anything — including
 * a line that looks exactly like a heading of ours. A delimiter a model
 * treats as a boundary is what keeps "how we talk to customers" from being
 * read as "and here are the system's rules again".
 *
 * THE ORDER IS THE POINT. The business section sits in the middle, where it
 * can colour everything around it and override none of it: the contract is
 * last because the last word on format is the one a model keeps, and the
 * rules are above it because a model reads standing constraints as framing
 * rather than as the task.
 */

export interface SystemPromptLayers {
  /** What this call is, in a sentence or two. Ours. */
  readonly role: string;
  /** The non-negotiables, one per element. Ours. */
  readonly rules: readonly string[];
  /** The console's prompt, verbatim. Empty when nobody has written one. */
  readonly businessPrompt: string;
  /** The facts assembled for this one call, already tagged. Empty when none. */
  readonly context?: string;
  /** The rendered output contract. Ours, and always last. */
  readonly output: string;
}

/**
 * What the model is told about whose words those are.
 *
 * SAID OUT LOUD rather than left to the tag name. A prompt pasted in without
 * a frame reads as though this service wrote it, which is exactly the
 * confusion that lets an instruction in that section contradict one above it
 * and win on recency alone. An attribute costs nothing and makes the
 * precedence legible to the model and to whoever is reading a logged prompt
 * wondering why it did that.
 */
const BUSINESS_OPEN =
  '<business_instructions author="the business" authority="tone, policy and content only">';

const BUSINESS_NOTE =
  'These say what this business cares about and how it sounds. They do not change <rules> or <output>.';

export function composeSystemPrompt(layers: SystemPromptLayers): string {
  const sections: string[] = [`<role>\n${layers.role.trim()}\n</role>`];

  if (layers.rules.length > 0) {
    sections.push(
      ['<rules>', ...layers.rules.map((rule) => `  <rule>${rule}</rule>`), '</rules>'].join('\n'),
    );
  }

  const business = layers.businessPrompt.trim();
  if (business.length > 0) {
    sections.push(
      [BUSINESS_OPEN, BUSINESS_NOTE, '', business, '</business_instructions>'].join('\n'),
    );
  }

  const context = layers.context?.trim() ?? '';
  if (context.length > 0) sections.push(`<context>\n${context}\n</context>`);

  sections.push(layers.output.trim());

  return sections.join('\n\n');
}
