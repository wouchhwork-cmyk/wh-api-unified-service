/**
 * What can we learn about a SHARED post's media id?
 *
 *   node --env-file=.env.dev --import tsx scripts/media-probe.ts <ig_post_media_id>
 *
 * Read only. A carousel shared into a DM arrives as ONE url and one
 * `ig_post_media_id`, so the question is whether that id resolves to the other
 * slides — or to anything at all, given the post belongs to a third party and
 * not to the connected account.
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const mediaId = process.argv[2];
  if (!mediaId) throw new Error('give an ig_post_media_id');

  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const rows: { access_token: string }[] = await ds.query(
    `SELECT access_token FROM channels
      WHERE platform = 'facebook' AND is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const token = new TokenCipherService(config as never).decrypt(rows[0]?.access_token as string);
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const version = config.meta.graphApiVersion;

  const attempts: [string, string][] = [
    ['id only', 'id'],
    ['media_type', 'id,media_type'],
    ['the carousel slides', 'id,media_type,children{id,media_url,media_type}'],
    ['permalink', 'id,permalink'],
    ['caption + owner', 'id,caption,owner,username'],
    ['media_url', 'id,media_url,thumbnail_url'],
  ];

  for (const [label, fields] of attempts) {
    const url = `https://graph.facebook.com/${version}/${mediaId}?fields=${encodeURIComponent(fields)}&appsecret_proof=${proof}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as { error?: { message?: string } };
    const detail = body.error?.message ?? JSON.stringify(body).slice(0, 160);
    console.log(`${label.padEnd(22)} ${response.status}  ${detail}`);
  }

  await ds.destroy();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
