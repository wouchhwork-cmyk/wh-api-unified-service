/** Every key Meta will return on a story_mention message. Read only. */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const mid = process.argv[2];
  const config = loadConfiguration();
  const ds = new DataSource({ ...buildDataSourceOptions(config.database), migrations: [] });
  await ds.initialize();
  const rows: { access_token: string }[] = await ds.query(
    `SELECT access_token FROM channels WHERE is_deleted = false AND access_token IS NOT NULL LIMIT 1`,
  );
  const token = new TokenCipherService(config as never).decrypt(rows[0]?.access_token as string);
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const v = config.meta.graphApiVersion;

  const r = await fetch(
    `https://graph.facebook.com/${v}/${mid}?fields=id,story&appsecret_proof=${proof}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await r.json()) as { story?: Record<string, unknown> };
  const story = body.story ?? {};
  console.log('story keys        :', Object.keys(story));
  const mention = (story.mention ?? {}) as Record<string, unknown>;
  console.log('story.mention keys:', Object.keys(mention));

  // Does the co-tagged account appear anywhere at all?
  console.log('story.mention.id  :', mention.id);
  console.log('asset_id in link  :', String(mention.link ?? '').match(/asset_id=(\d+)/)?.[1]);
  await ds.destroy();
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
