import { describe, expect, it } from 'vitest';
import { canonicalPrompt, fingerprint, tagTurn, turnIdsOf } from '@/modules/ai/prompts';

/**
 * What makes a rebuilt prompt checkable.
 *
 * The prompt itself is never stored — it carries the customer's own words —
 * so "here is what the model saw" is a reconstruction. A reconstruction
 * nobody can verify is a story; the fingerprint is what turns it into a
 * claim that can be falsified.
 */
describe('naming a turn', () => {
  it('writes and reads the same marker', () => {
    const tagged = tagTurn('4f2c8b1a', 'are you open?');

    expect(tagged).toBe('[id:4f2c8b1a] are you open?');
    expect(turnIdsOf([{ role: 'user', text: tagged }])).toEqual(['4f2c8b1a']);
  });

  it('keeps the order the conversation happened in', () => {
    const turns = [
      { role: 'user' as const, text: tagTurn('a', 'one') },
      { role: 'assistant' as const, text: tagTurn('b', 'two') },
      { role: 'user' as const, text: tagTurn('c', 'three') },
    ];

    expect(turnIdsOf(turns)).toEqual(['a', 'b', 'c']);
  });

  it('ignores a turn that carries no marker rather than inventing one', () => {
    expect(turnIdsOf([{ role: 'user', text: 'untagged' }])).toEqual([]);
  });

  it('says how a message arrived, when it was not plain text', () => {
    expect(tagTurn('a', 'love this', { kind: 'story_reply' })).toBe(
      '[id:a kind:story_reply] love this',
    );
  });

  it('leaves plain text unsaid, because every message would pay for it', () => {
    /* `kind:text` is nearly every turn and tells a model nothing it could
     * not get by reading the words. */
    expect(tagTurn('a', 'hello', { kind: 'text' })).toBe('[id:a] hello');
  });

  it('names what a message answers, so a reply can be traced', () => {
    expect(tagTurn('b', 'yes', { kind: 'text', replyTo: 'a' })).toBe('[id:b re:a] yes');
  });

  it('still reads the id out of a marker carrying everything', () => {
    const tagged = tagTurn('b', 'yes', { kind: 'story_reply', replyTo: 'a' });
    expect(turnIdsOf([{ role: 'user', text: tagged }])).toEqual(['b']);
  });

  it('is not fooled by a customer writing one into their message', () => {
    /* The marker is only ours at the START of a turn. One typed into the
     * middle of a sentence names nothing. */
    const tagged = tagTurn('real', 'they said [id:fake] in the middle');

    expect(turnIdsOf([{ role: 'user', text: tagged }])).toEqual(['real']);
  });
});

describe('fingerprinting a prompt', () => {
  const turns = [{ role: 'user' as const, text: tagTurn('a', 'are you open?') }];

  it('is stable for the same prompt', () => {
    const once = fingerprint(canonicalPrompt({ instructions: '<rules/>', turns }));
    const twice = fingerprint(canonicalPrompt({ instructions: '<rules/>', turns }));

    expect(once).toBe(twice);
    expect(once).toHaveLength(64);
  });

  it('moves when the instruction changes', () => {
    expect(fingerprint(canonicalPrompt({ instructions: '<rules>a</rules>', turns }))).not.toBe(
      fingerprint(canonicalPrompt({ instructions: '<rules>b</rules>', turns })),
    );
  });

  it('moves when a single message changes', () => {
    const edited = [{ role: 'user' as const, text: tagTurn('a', 'are you open now?') }];

    expect(fingerprint(canonicalPrompt({ instructions: '<rules/>', turns }))).not.toBe(
      fingerprint(canonicalPrompt({ instructions: '<rules/>', turns: edited })),
    );
  });

  /**
   * The point of canonicalising rather than hashing what each client sent:
   * OpenAI takes role items and an instructions field, Gemini one flat text
   * part. Hashing the wire format would make two identical prompts hash
   * differently and the comparison would mean nothing.
   */
  it('does not depend on how a provider happens to carry it', () => {
    const rendered = canonicalPrompt({ instructions: '<rules/>', turns });

    expect(rendered).toContain('<rules/>');
    expect(rendered).toContain('Them: [id:a] are you open?');
  });
});
