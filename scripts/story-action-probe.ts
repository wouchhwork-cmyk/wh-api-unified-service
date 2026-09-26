/**
 * Can we LIKE a story mention, and can we reply to it?
 *
 *   node --env-file=.env.dev --import tsx scripts/story-action-probe.ts <mid> <recipient-igsid>
 *
 * Reacts, reports, then UNREACTS — so it leaves nothing behind. A story mention
 * arrives as a message, and reactions take a message_id, so this is the shape a
 * "like on a story" would actually have if it exists.
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const mid = process.argv[2];
  const recipient = process.argv[3];
  if (!mid || !recipient) throw new Error('give <mid> <recipient-igsid>');

  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const rows: { access_token: string; platform_channel_id: string }[] = await ds.query(
    `SELECT access_token, platform_channel_id FROM channels
      WHERE platform = 'instagram' AND is_deleted = false LIMIT 1`,
  );
  const fb: { access_token: string }[] = await ds.query(
    `SELECT access_token FROM channels
      WHERE platform = 'facebook' AND is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  /*
   * THE PAGE ID, not the Instagram user id. Instagram messaging with a Page
   * token goes through the Page node — posting to the IG id returns #3
   * "Application does not have the capability", which reads like a missing
   * permission and is really a wrong endpoint.
   */
  const page: { platform_channel_id: string }[] = await ds.query(
    `SELECT platform_channel_id FROM channels
      WHERE platform = 'facebook' AND is_deleted = false LIMIT 1`,
  );
  const igId = page[0]?.platform_channel_id as string;
  const token = new TokenCipherService(config as never).decrypt(
    (rows[0]?.access_token || fb[0]?.access_token) as string,
  );
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');

  const post = async (label: string, payload: Record<string, unknown>): Promise<void> => {
    const r = await fetch(
      `https://graph.facebook.com/${config.meta.graphApiVersion}/${igId}/messages?appsecret_proof=${proof}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    const body = (await r.json()) as { error?: { message?: string; code?: number } };
    console.log(
      `${label.padEnd(24)} ${r.status}  ${body.error ? `#${body.error.code} ${body.error.message}` : 'OK'}`,
    );
  };

  await post('react (love)', {
    recipient: { id: recipient },
    sender_action: 'react',
    payload: { message_id: mid, reaction: 'love' },
  });
  await post('unreact', {
    recipient: { id: recipient },
    sender_action: 'unreact',
    payload: { message_id: mid },
  });

  await ds.destroy();
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
