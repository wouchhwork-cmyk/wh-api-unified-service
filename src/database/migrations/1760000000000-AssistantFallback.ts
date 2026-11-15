import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the customer hears when the assistant cannot answer.
 *
 * SILENCE IS THE WORST OUTCOME. With automatic replies on, a customer has
 * been told — by the speed of every previous answer — that somebody is
 * there. A model call that fails then reads as being ignored, which is worse
 * than never having answered quickly in the first place.
 *
 * So a failure sends a short human line instead: stepping away, will come
 * back. It is EDITABLE because it is the business's voice, not ours, and
 * because the right words differ by trade and by language. Empty means send
 * nothing, for a business that would rather say nothing than say this.
 */
export class AssistantFallback1760000000000 implements MigrationInterface {
  name = 'AssistantFallback1760000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE platform_settings
          SET value = value || jsonb_build_object('fallbackMessage', $1::text)
        WHERE key = 'chat' AND value->>'fallbackMessage' IS NULL`,
      ["Sorry, I have to step away for something urgent — I'll get back to you shortly."],
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE platform_settings SET value = value - 'fallbackMessage' WHERE key = 'chat'`,
    );
  }
}
