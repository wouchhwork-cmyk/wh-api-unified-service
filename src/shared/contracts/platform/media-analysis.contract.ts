import { z } from 'zod';

/**
 * What staff may change about how the product reads media.
 *
 * TWO FIELDS, AND BOTH ARE LOADED. The prompt decides what every description
 * says; the model decides what every description costs. Putting them behind a
 * console rather than a release is the point of the feature — the first
 * hundred real photos teach you more about the instruction than any amount of
 * writing it carefully beforehand.
 */
export const UpdateMediaAnalysisSettingsSchema = z.strictObject({
  /**
   * The model id, UNCONSTRAINED BY AN ENUM on purpose.
   *
   * Google retires and renames these on their own schedule — two are being
   * auto-routed away on 1 December 2026 — so a fixed list here would be a
   * second place to edit every time that happens, and the one most likely to
   * be forgotten. The model is validated by the only authority that counts:
   * the next call either resolves it or fails, and the failure is recorded
   * against the media it was trying to describe.
   */
  model: z
    .string()
    .trim()
    .min(1, 'a model is required')
    .max(80)
    .regex(/^[a-z0-9][a-z0-9.\-_]*$/i, 'that is not a model id'),
  /**
   * What this business wants noticed, sent with every piece of media.
   *
   * NO FLOOR ANY MORE. It used to be the whole instruction, so twenty
   * characters of it was a reasonable thing to insist on; it is now one
   * section inside a frame that carries the output shape and the rules on
   * its own, and "nothing in particular" is a legitimate answer to what else
   * to look for. Blank means the default.
   *
   * Still bounded above, because it is sent with every request and therefore
   * billed on every one — a prompt that grows without anybody noticing is a
   * bill that grows without anybody noticing.
   */
  prompt: z.string().trim().max(8000),
});

export type UpdateMediaAnalysisSettingsInput = z.infer<typeof UpdateMediaAnalysisSettingsSchema>;
