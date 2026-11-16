import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A model and a key PER PROVIDER, rather than one of each for whichever is
 * selected.
 *
 * THE OLD SHAPE HAD A FOOTGUN. `model` was a single field beside `provider`,
 * so switching provider in the console left the previous provider's model id
 * behind — and `gpt-6-luna` means nothing to Google. The console warned about
 * it in prose, which is the weakest kind of guard. Now each provider carries
 * its own model and switching picks up the right one.
 *
 * KEYS LIVE HERE TOO, encrypted with the same cipher as Meta's tokens: the
 * column holds a self-describing AES-256-GCM envelope, so a dump, a replica
 * or a stolen disk yields nothing usable. They are a fallback FROM the
 * environment rather than a replacement for it — an environment key still
 * works, and is still what most deployments should use.
 */
export class ChatProviderCredentials1760200000000 implements MigrationInterface {
  name = 'ChatProviderCredentials1760200000000';

  public async up(q: QueryRunner): Promise<void> {
    /*
     * The model that is already saved belongs to the provider that is already
     * selected; the other provider gets nothing rather than a guess, and
     * falls back to its environment default until somebody chooses one.
     */
    await q.query(`
      UPDATE platform_settings
         SET value = (value - 'model') || jsonb_build_object(
               'models',
               jsonb_build_object(coalesce(value->>'provider', 'openai'), value->>'model')
             )
       WHERE key = 'chat'
         AND value ? 'model'
         AND NOT (value ? 'models')
    `);
  }

  /**
   * Back to one flat model, taken from whichever provider is selected — the
   * only one the old shape could have held.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE platform_settings
         SET value = (value - 'models' - 'apiKeys') || jsonb_build_object(
               'model',
               coalesce(value->'models'->>(coalesce(value->>'provider', 'openai')), '')
             )
       WHERE key = 'chat' AND value ? 'models'
    `);
  }
}
