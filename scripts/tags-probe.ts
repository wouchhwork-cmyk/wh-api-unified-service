/** Posts by OTHER people that tagged this account. Read only. */
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
  const fields = 'id,caption,media_type,media_url,permalink,username,timestamp';
  const r = await fetch(
    `https://graph.facebook.com/${config.meta.graphApiVersion}/${ig[0]?.platform_channel_id}/tags` +
      `?fields=${encodeURIComponent(fields)}&limit=10&appsecret_proof=${proof}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await r.json()) as {
    data?: { id: string; username?: string; caption?: string; permalink?: string; timestamp?: string }[];
    error?: { message?: string };
  };
  if (body.error) { console.log('refused:', body.error.message); }
  else {
    console.log(`HTTP ${r.status} — ${body.data?.length ?? 0} tagged posts`);
    for (const m of body.data ?? []) {
      console.log(`  ${m.id}  @${m.username}  ${String(m.timestamp).slice(0, 19)}`);
      console.log(`     ${String(m.caption ?? '').slice(0, 60).replace(/\n/g, ' ')}`);
    }
  }
  await ds.destroy();
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
