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
   * The model id, UNCONSTRAINED BY AN ENUM on purpose.
   *
   * OpenAI retires these on their own schedule — `gpt-5-nano` shuts down on
   * 11 December 2026 — so a fixed list here would be a second place to edit
   * every time and the one most likely to be forgotten. The id is validated
   * by the only authority that counts: the next call either resolves it or
   * fails.
   */
  model: z
    .string()
    .trim()
    .min(1, 'a model is required')
    .max(80)
    .regex(/^[a-z0-9][a-z0-9.\-_]*$/i, 'that is not a model id'),
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
