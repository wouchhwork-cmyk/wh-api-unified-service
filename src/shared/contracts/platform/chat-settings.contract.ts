import { z } from 'zod';
import { AiProvider } from '@/modules/ai/ai.provider';

/**
 * What staff may change about how the assistant replies.
 *
 * THE SAME TWO FIELDS the media console has, for the same two reasons: the
 * prompt decides what every reply SAYS, the model decides what every reply
 * COSTS. Both behind a console rather than a release, because an instruction
 * is only ever right in the presence of real conversations.
 */
const ModelId = z
  .string()
  .trim()
  .min(1, 'a model is required')
  .max(80)
  .regex(/^[a-z0-9][a-z0-9.\-_]*$/i, 'that is not a model id');

export const UpdateChatSettingsSchema = z.strictObject({
  /**
   * Which provider answers.
   *
   * AN ENUM, UNLIKE THE MODEL, and the difference is not arbitrary: a
   * provider is a client we have written and a key we hold, so the list is
   * ours and is exactly as long as the code says. A model id is theirs.
   */
  provider: z.enum(AiProvider),
  /**
   * The platform's own switch for automatic replies.
   *
   * A KILL SWITCH, NOT A CONSENT. Each business opts in for itself; this says
   * whether we are willing to run any of it at all, so an assistant behaving
   * badly can be stopped everywhere in one edit instead of business by
   * business while it keeps talking.
   */
  autoReply: z.boolean(),
  /**
   * What the customer hears when the assistant cannot answer.
   *
   * With automatic replies on, every fast answer has told the customer that
   * somebody is there — so a failure that says nothing reads as being
   * ignored. This is the short human line sent instead.
   *
   * EMPTY MEANS SEND NOTHING, which is a real choice: a business may prefer
   * silence to an apology it did not write. Bounded hard, because it is a
   * fixed string sent to customers and nothing about it needs length.
   */
  fallbackMessage: z.string().trim().max(500),
  /**
   * What the customer hears while their photo is still being looked at.
   *
   * Media is described by a worker seconds after it arrives, so a message
   * carrying only a photo reaches the assistant before there is anything to
   * answer about. This holds the moment; the real answer follows when the
   * description lands. Empty means wait silently and answer once.
   */
  mediaHoldMessage: z.string().trim().max(500),
  /**
   * A model id, UNCONSTRAINED BY AN ENUM on purpose.
   *
   * OpenAI retires these on their own schedule — `gpt-5-nano` shuts down on
   * 11 December 2026 — so a fixed list here would be a second place to edit
   * every time and the one most likely to be forgotten. The id is validated
   * by the only authority that counts: the next call either resolves it or
   * fails.
   */
  models: z.object({
    openai: ModelId,
    gemini: ModelId,
  }),
  /**
   * A key per provider, OPTIONAL PER PROVIDER AND NEVER RETURNED.
   *
   * Three states, and they must stay distinct. ABSENT means "I am not
   * talking about this key" — which is what a console sends on every save
   * where nobody typed one, because the form cannot show the current value
   * to put back. `null` means "remove it", falling back to the environment.
   * A string sets a new one.
   *
   * Conflating absent with empty would wipe a working key on every unrelated
   * save of the prompt.
   */
  apiKeys: z
    .object({
      openai: z.string().trim().min(1).max(200).nullable().optional(),
      gemini: z.string().trim().min(1).max(200).nullable().optional(),
    })
    .optional(),
  /**
   * The standing instruction sent with every conversation.
   *
   * Bounded because it is prepended to every request and therefore billed on
   * every one — an instruction that grows without anybody noticing is a bill
   * that grows without anybody noticing.
   */
  prompt: z.string().trim().min(20, 'the instruction is too short to be useful').max(8000),
});

export type UpdateChatSettingsInput = z.infer<typeof UpdateChatSettingsSchema>;
