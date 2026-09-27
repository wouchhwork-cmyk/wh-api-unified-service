/**
 * Can we read the comments on a post we were tagged in, and who wrote them?
 *
 *   node --env-file=.env.dev --import tsx scripts/post-comments-probe.ts <media_id>
 *
 * Read only. Tries every shape for the author, because the comment TEXT being
 * readable while the AUTHOR is not is the established pattern here (1.4).
 */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
  const mediaId = process.argv[2];
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
  const token = new TokenCipherService(config as never).decrypt(
    (ig[0]?.access_token || fb[0]?.access_token) as string,
  );
  const proof = createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const igId = ig[0]?.platform_channel_id as string;

  const ask = async (label: string, inner: string): Promise<void> => {
    const fields = `mentioned_media.media_id(${mediaId}){${inner}}`;
    const r = await fetch(
      `https://graph.facebook.com/${config.meta.graphApiVersion}/${igId}` +
        `?fields=${encodeURIComponent(fields)}&appsecret_proof=${proof}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = (await r.json()) as { error?: { message?: string; code?: number } };
    const text = body.error
      ? `#${body.error.code} ${String(body.error.message).slice(0, 78)}`
      : JSON.stringify(body).slice(0, 320);
    console.log(`  ${label.padEnd(26)} ${r.status}  ${text}`);
  };

  console.log(`\nmedia ${mediaId}`);
  await ask('comment text + time', 'id,comments{id,text,timestamp}');
  await ask('author: username', 'id,comments{id,text,username}');
  await ask('author: from{...}', 'id,comments{id,text,from{id,username,name}}');
  await ask('author: user{...}', 'id,comments{id,text,user}');
  await ask('likes + replies', 'id,comments{id,text,like_count,replies{id,text}}');
  await ask('comments_count only', 'id,comments_count');

  await ds.destroy();
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
