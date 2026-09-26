/**
 * Asks Meta directly what it knows about one message id.
 *
 *   node --env-file=.env.dev --import tsx scripts/probe-message.ts <mid>
 *
 * READ ONLY, and written to answer one question with evidence rather than
 * recollection: when a webhook arrives carrying `is_unsupported: true` and
 * nothing else, is the content recoverable by asking for it by id?
 */
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const mid = process.argv[2];
  if (!mid) throw new Error('give a message id');

  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();

  const rows: { access_token: string; platform_channel_id: string }[] = await ds.query(
    `SELECT access_token, platform_channel_id FROM channels
      WHERE platform = 'facebook' AND is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const channel = rows[0];
  if (!channel) throw new Error('no facebook channel with a token');

  const cipher = new TokenCipherService(config as never);
  const token = cipher.decrypt(channel.access_token);
  const version = config.meta.graphApiVersion;

  // Every field that could plausibly describe a share, asked for by name.
  const attempts: [string, string][] = [
    ['id only', 'id'],
    ['message + from', 'id,message,created_time,from'],
    ['attachments', 'id,attachments'],
    ['shares', 'id,shares'],
    ['story', 'id,story'],
    ['everything at once', 'id,message,created_time,from,to,attachments,shares,story,sticker'],
  ];

  for (const [label, fields] of attempts) {
    const url = `https://graph.facebook.com/${version}/${mid}?fields=${encodeURIComponent(fields)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await response.text();
    console.log(`\n--- ${label} (${fields}) → HTTP ${response.status}`);
    console.log(text.slice(0, 900));
  }

  await ds.destroy();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
