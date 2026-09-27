/**
 * On a post we are tagged in — can we comment on it, or like it?
 *
 *   node --env-file=.env.dev --import tsx scripts/post-action-probe.ts <media_id> "<comment text>"
 *
 * THE COMMENT IS A REAL WRITE and cannot be deleted afterwards on somebody
 * else's media (platform-limitations 4.6). The like attempts are reads-then-
 * writes against endpoints that may not exist; each is reported separately so a
 * refusal can be told from a silent success.
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const mediaId = process.argv[2];
  const text = process.argv[3] ?? 'Thanks for the tag!';
  if (!mediaId) throw new Error('give a media_id');

  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const ig: { platform_channel_id: string; access_token: string }[] = await ds.query(
    `SELECT platform_channel_id, access_token FROM channels
      WHERE platform = 'instagram' AND is_deleted = false LIMIT 1`,
  );
  const fb: { access_token: string }[] = await ds.query(
    `SELECT access_token FROM channels
      WHERE platform = 'facebook' AND is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const igId = ig[0]?.platform_channel_id as string;
  const token = new TokenCipherService(config as never).decrypt(
    (ig[0]?.access_token || fb[0]?.access_token) as string,
  );
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const v = config.meta.graphApiVersion;

  const call = async (label: string, path: string, body: Record<string, string>): Promise<void> => {
    const r = await fetch(`https://graph.facebook.com/${v}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...body, appsecret_proof: proof }),
    });
    const out = (await r.json()) as { id?: string; success?: boolean; error?: { message?: string; code?: number } };
    console.log(
      `  ${label.padEnd(30)} ${r.status}  ` +
        (out.error ? `#${out.error.code} ${String(out.error.message).slice(0, 68)}` : `OK ${out.id ?? ''}`),
    );
  };

  console.log(`\nmedia ${mediaId}`);
  await call('comment via /mentions', `${igId}/mentions`, { media_id: mediaId, message: text });
  await call('comment via /{media}/comments', `${mediaId}/comments`, { message: text });
  await call('like via /{media}/likes', `${mediaId}/likes`, {});

  await ds.destroy();
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
