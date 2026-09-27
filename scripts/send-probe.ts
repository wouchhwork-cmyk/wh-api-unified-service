/**
 * What the Instagram send API will accept.
 *
 *   node --env-file=.env.dev --import tsx scripts/send-probe.ts <igsid> <kind> [url]
 *
 * kinds: text | image | video | audio | gif | multi
 *
 * REAL SENDS. Goes through {page-id}/messages, which is the node Instagram
 * messaging lives on (platform-limitations 4.5).
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const [, , recipient, kind = 'text', url] = process.argv;
  if (!recipient) throw new Error('give an igsid');

  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const page: { platform_channel_id: string; access_token: string }[] = await ds.query(
    `SELECT platform_channel_id, access_token FROM channels
      WHERE platform = 'facebook' AND is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const token = new TokenCipherService(config as never).decrypt(page[0]?.access_token as string);
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');

  const attachment = (type: string) => ({
    attachment: { type, payload: { url, is_reusable: false } },
  });
  const bodies: Record<string, unknown> = {
    text: { text: 'checking the reply window' },
    image: attachment('image'),
    video: attachment('video'),
    audio: attachment('audio'),
    gif: attachment('image'),
    multi: attachment('image'),
  };

  const r = await fetch(
    `https://graph.facebook.com/${config.meta.graphApiVersion}/${page[0]?.platform_channel_id}/messages?appsecret_proof=${proof}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipient }, message: bodies[kind] }),
    },
  );
  const out = (await r.json()) as {
    message_id?: string;
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  console.log(
    `  ${kind.padEnd(7)} -> ${recipient}  ${r.status}  ` +
      (out.error
        ? `#${out.error.code}${out.error.error_subcode ? '/' + out.error.error_subcode : ''} ${String(out.error.message).slice(0, 80)}`
        : `SENT ${out.message_id}`),
  );
  await ds.destroy();
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
