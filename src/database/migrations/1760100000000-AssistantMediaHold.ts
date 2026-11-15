import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the customer hears while the assistant is still looking at their
 * photo.
 *
 * MEDIA IS DESCRIBED BY A WORKER, SECONDS AFTER IT ARRIVES. The automatic
 * reply fired the instant the message landed, which for a photo sent with no
 * text meant answering with nothing to answer about — the first real one
 * failed with "the model returned no text" and fell back to an apology, for
 * a message that was about to be perfectly answerable.
 *
 * So a message whose media is still queued gets this line now, and the real
 * answer when the description lands. Editable and empty-able for the same
 * reasons as the fallback beside it.
 */
export class AssistantMediaHold1760100000000 implements MigrationInterface {
  name = 'AssistantMediaHold1760100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE platform_settings
          SET value = value || jsonb_build_object('mediaHoldMessage', $1::text)
        WHERE key = 'chat' AND value->>'mediaHoldMessage' IS NULL`,
      ['Let me take a look at that…'],
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE platform_settings SET value = value - 'mediaHoldMessage' WHERE key = 'chat'`,
    );
  }
}
