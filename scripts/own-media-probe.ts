/** Our own recent media and the live comments on it. Read only. */
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source';
import { loadConfiguration } from '../src/config/configuration';
import { TokenCipherService } from '../src/shared/crypto/token-cipher.service';

async function main(): Promise<void> {
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
  const fields =
    'id,caption,media_type,permalink,timestamp,comments_count,' +
    'comments{id,text,timestamp,username,hidden,like_count,replies{id,text,username}}';
  const r = await fetch(
    `https://graph.facebook.com/${config.meta.graphApiVersion}/${ig[0]?.platform_channel_id}/media` +
      `?fields=${encodeURIComponent(fields)}&limit=5&appsecret_proof=${proof}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await r.json()) as {
    data?: {
      id: string;
      caption?: string;
      media_type?: string;
      timestamp?: string;
      comments_count?: number;
      comments?: { data?: { id: string; text?: string; username?: string; hidden?: boolean }[] };
    }[];
    error?: { message?: string };
  };
  if (body.error) { console.log('refused:', body.error.message); }
  else {
    for (const m of body.data ?? []) {
      console.log(`\n${m.id}  ${m.media_type}  ${String(m.timestamp).slice(0, 10)}  comments=${m.comments_count ?? 0}`);
      console.log(`  caption: ${String(m.caption ?? '').slice(0, 55).replace(/\n/g, ' ')}`);
      for (const c of m.comments?.data ?? []) {
        console.log(`  COMMENT ${c.id}  @${c.username ?? '?'}  hidden=${c.hidden}  "${String(c.text ?? '').slice(0, 34)}"`);
      }
    }
  }
  await ds.destroy();
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
