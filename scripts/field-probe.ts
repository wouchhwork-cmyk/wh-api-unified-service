/**
 * Which requested FIELD is costing us a permission?
 *
 *   node --env-file=.env.dev --import tsx scripts/field-probe.ts
 *
 * Read only. Asks `published_posts` for one field at a time so a #10 can be
 * attributed to the field that causes it rather than to the whole walk.
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const rows: { access_token: string; platform_channel_id: string }[] = await ds.query(
    `SELECT access_token, platform_channel_id FROM channels
      WHERE platform = 'facebook' AND is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const channel = rows[0];
  if (!channel) throw new Error('no facebook channel');
  const token = new TokenCipherService(config as never).decrypt(channel.access_token);
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');

  const candidates: [string, string][] = [
    ['core only', 'id,message,created_time,permalink_url,status_type'],
    ['+ full_picture', 'id,full_picture'],
    ['+ attachments', 'id,attachments{type,media}'],
    ['+ reactions summary', 'id,reactions.summary(total_count).limit(0)'],
    ['+ shares', 'id,shares'],
    ['+ comment_summary', 'id,comment_summary:comments.summary(total_count).limit(0)'],
    ['+ nested comments', 'id,comments.limit(1){id,message}'],
  ];

  for (const [label, fields] of candidates) {
    const url =
      `https://graph.facebook.com/${config.meta.graphApiVersion}/${channel.platform_channel_id}` +
      `/published_posts?limit=1&fields=${encodeURIComponent(fields)}&appsecret_proof=${proof}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as { error?: { message?: string } };
    console.log(`${label.padEnd(22)} ${response.status}  ${body.error?.message ?? 'OK'}`);
  }

  await ds.destroy();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
